import {
  INTERACTION_STATUSES,
  SYSTEM_JOB_PRIORITIES,
  TASK_STATUSES,
} from '@orca/types';
import { nanoid } from 'nanoid';
import type { EventSink } from '../api/ws';
import type { OrcaDrizzleDB } from '../db/connection';
import type { Config, TaskEntry } from '../db/schema';
import { normalizeProposedTasks, runBreakdown } from '../domain/breakdown';
import { evaluateTask } from '../domain/evaluate';
import {
  type BudgetedRetrievalResult,
  buildMemoryContext,
  retrieveBudgetedMemory,
} from '../domain/memory-retrieval';
import { refreshMemoryEntries } from '../domain/memory-sync';
import type { ToolPluginRegistry } from '../plugin/registry';
import type { JobQueue } from '../queue/queue';
import * as configStore from '../store/config';
import type { InteractionStore } from '../store/interactions';
import type { MemoryStore } from '../store/memory';
import * as taskStore from '../store/tasks';
import type { ProposedTask, TaskEvaluation } from '../types/api';
import type { WorkflowStore } from '../workflow/store';

interface ToolModelOverrides {
  toolOverride?: string;
  modelOverride?: string;
}

interface EvaluateTaskWorkflowDeps extends ToolModelOverrides {
  repoDir: string;
  db: OrcaDrizzleDB;
  sink?: EventSink;
  interactions: InteractionStore;
  registry: ToolPluginRegistry;
  workflowStore?: WorkflowStore;
  resumeSessionID?: string;
  feedback?: string;
}

interface BreakdownTaskInput extends ToolModelOverrides {
  taskId?: string;
  goal?: string;
}

interface BreakdownTaskWorkflowDeps {
  repoDir?: string;
  db: OrcaDrizzleDB;
  sink?: EventSink;
  interactions?: InteractionStore;
  registry?: ToolPluginRegistry;
  memory?: MemoryStore;
}

interface BreakdownTaskResult {
  taskId?: string;
  proposed: ProposedTask[];
  interactionId?: string;
  tool?: string;
  model?: string;
}

interface AcceptBreakdownResult {
  createdIds: string[];
  parentId?: string;
}

interface EvaluateTaskWorkflowResult {
  evaluation: TaskEvaluation;
  sessionId: string;
}

export async function evaluateTaskWorkflow(
  taskID: string,
  deps: EvaluateTaskWorkflowDeps,
): Promise<EvaluateTaskWorkflowResult> {
  const task = await getTask(taskID, deps.db);
  const config = await configStore.loadConfig(deps.db);

  return await evaluateTask(task, {
    repoDir: deps.repoDir,
    config,
    registry: deps.registry,
    interactions: deps.interactions,
    workflowStore: deps.workflowStore,
    toolOverride: deps.toolOverride ?? '',
    modelOverride: deps.modelOverride ?? '',
    resumeSessionID: deps.resumeSessionID,
    feedback: deps.feedback,
  });
}

export async function breakdownTask(
  input: BreakdownTaskInput,
  deps: BreakdownTaskWorkflowDeps,
): Promise<BreakdownTaskResult> {
  const taskID = (input.taskId ?? '').trim();
  const goal = (input.goal ?? '').trim();
  if (!taskID && !goal) {
    throw new Error('goal or taskId is required');
  }

  let task: TaskEntry | null = null;
  if (taskID) {
    task = await getTask(taskID, deps.db);
  }

  const title = task?.title ?? goal;
  const description = task?.description ?? '';

  if (!canRunLLMBreakdown(deps)) {
    throw new Error(
      'breakdown requires a configured LLM tool — check config.tools and orchestrator settings',
    );
  }

  const config = await configStore.loadConfig(deps.db);
  const memoryResult = await retrievePlanningMemory({
    repoDir: deps.repoDir,
    db: deps.db,
    memory: deps.memory,
    taskId: task?.id,
    title: title || 'Task Breakdown',
    description: description || goal,
    config,
    registry: deps.registry,
    interactions: deps.interactions,
  });

  const result = await runBreakdown({
    repoDir: deps.repoDir,
    config,
    registry: deps.registry,
    interactions: deps.interactions,
    goal: [title, description].filter(Boolean).join('\n\n').trim() || goal,
    taskID: task?.id || undefined,
    memoryContext: memoryResult.memoryContext,
    toolOverride: input.toolOverride ?? '',
    modelOverride: input.modelOverride ?? '',
  });

  return {
    taskId: task?.id,
    proposed: result.proposed,
    interactionId: result.interactionId,
    tool: result.tool,
    model: result.model,
  };
}

export async function acceptBreakdown(
  parentID: string | null,
  proposals: ProposedTask[],
  deps: { db: OrcaDrizzleDB; sink?: EventSink; queue?: JobQueue },
): Promise<AcceptBreakdownResult> {
  const normalizedParentID = (parentID ?? '').trim();
  if (normalizedParentID) {
    await getTask(normalizedParentID, deps.db);
  }

  const normalizedProposals = normalizeProposedTasks(proposals);
  const createdIDs: string[] = [];

  for (const item of normalizedProposals) {
    const id = nanoid();
    await taskStore.createTask(deps.db, deps.sink, {
      id,
      title: item.title,
      description: item.description,
      parentId: normalizedParentID || null,
      autoRunOverrides: {},
    });
    createdIDs.push(id);
  }

  // Set deps before enqueueing evaluate so dep checks work
  for (const [index, item] of normalizedProposals.entries()) {
    const taskID = createdIDs[index];
    const dependencyIDs = (item.dependsOnIndices ?? [])
      .map((depIndex) => createdIDs[depIndex] ?? '')
      .filter(Boolean);
    if (dependencyIDs.length > 0 && taskID) {
      for (const depID of dependencyIDs) {
        await taskStore.addDependency(deps.db, deps.sink, taskID, depID);
      }
    }
  }

  // Only enqueue evaluate for tasks with all deps met (or no deps)
  if (deps.queue) {
    for (const taskId of createdIDs) {
      const met = await taskStore.areDependenciesMet(deps.db, taskId);
      if (met) {
        await deps.queue.enqueue({
          type: 'evaluate',
          taskId,
          priority: SYSTEM_JOB_PRIORITIES.evaluate,
        });
      }
    }
  }

  if (normalizedParentID) {
    await taskStore.updateTaskStatus(
      deps.db,
      deps.sink,
      normalizedParentID,
      TASK_STATUSES.broken_down,
    );
  }

  return {
    createdIds: createdIDs,
    parentId: normalizedParentID || undefined,
  };
}

export async function rejectBreakdown(
  taskID: string,
  interactionID: string,
  deps: { interactions: InteractionStore },
): Promise<void> {
  const normalizedInteractionID = interactionID.trim();
  if (!normalizedInteractionID) return;

  const interaction = await deps.interactions.get(normalizedInteractionID);
  if (!interaction) return;

  await deps.interactions.finish(normalizedInteractionID, {
    status: INTERACTION_STATUSES.completed,
    output: JSON.stringify({
      result: 'rejected',
      data: { taskId: taskID, rejected: true },
    }),
  });
}

export async function loadProposedTasksFromInteraction(
  interactionID: string,
  deps: { interactions: InteractionStore },
): Promise<ProposedTask[]> {
  const normalizedInteractionID = interactionID.trim();
  if (!normalizedInteractionID) return [];

  const interaction = await deps.interactions.get(normalizedInteractionID);
  if (!interaction?.output) return [];

  try {
    const parsed = JSON.parse(interaction.output) as {
      result?: string;
      data?: { proposed?: ProposedTask[] };
    };
    const proposed = parsed.data?.proposed;
    if (!Array.isArray(proposed)) return [];
    return normalizeProposedTasks(proposed);
  } catch {
    return [];
  }
}

async function retrievePlanningMemory(input: {
  repoDir: string;
  db: OrcaDrizzleDB;
  memory?: MemoryStore;
  taskId?: string;
  title: string;
  description: string;
  config: Config;
  registry: ToolPluginRegistry;
  interactions: InteractionStore;
}): Promise<{ memoryContext: string; memory?: BudgetedRetrievalResult }> {
  if (!input.memory) {
    return {
      memoryContext: '',
    };
  }
  const memoryStore = input.memory;

  const memory = await retrieveBudgetedMemory(memoryStore, input.db, {
    taskId: input.taskId,
    title: input.title,
    description: input.description,
    syncer: {
      refresh: async (entryID: string) => {
        await refreshMemoryEntries(input.repoDir, memoryStore, entryID, {
          config: input.config,
          registry: input.registry,
          interactions: input.interactions,
        });
      },
    },
  });

  return {
    memory,
    memoryContext: buildMemoryContext(memory),
  };
}

function canRunLLMBreakdown(
  deps: BreakdownTaskWorkflowDeps,
): deps is BreakdownTaskWorkflowDeps & {
  repoDir: string;
  interactions: InteractionStore;
  registry: ToolPluginRegistry;
} {
  return Boolean(deps.repoDir && deps.interactions && deps.registry);
}

async function getTask(taskID: string, db: OrcaDrizzleDB): Promise<TaskEntry> {
  try {
    return await taskStore.getTask(db, taskID);
  } catch {
    throw new Error(`task not found: ${taskID}`);
  }
}
