import {
  generateProposedSubtasks,
  normalizeProposedTasks,
  runBreakdown,
} from '../domain/breakdown';
import { evaluateTask } from '../domain/evaluate';
import {
  type BudgetedRetrievalResult,
  buildMemoryContext,
  retrieveBudgetedMemory,
} from '../domain/memory-retrieval';
import { refreshMemoryEntries } from '../domain/memory-sync';
import { generateGlobalPlan, runPlan } from '../domain/plan';
import type { ToolPluginRegistry } from '../plugin/registry';
import type { JobQueue } from '../queue/queue';
import type { ConfigStore } from '../store/config';
import type { InteractionStore } from '../store/interactions';
import type { MemoryStore } from '../store/memory';
import type { TaskStore } from '../store/tasks';
import type { Config, ProposedTask, Task, TaskEvaluation } from '../types';
import { INTERACTION_STATUSES, JOB_PRIORITIES, TASK_STATUSES } from '../types';

interface ToolModelOverrides {
  toolOverride?: string;
  modelOverride?: string;
}

interface EvaluateTaskWorkflowDeps extends ToolModelOverrides {
  repoDir: string;
  taskStore: TaskStore;
  interactions: InteractionStore;
  configStore: ConfigStore;
  registry: ToolPluginRegistry;
}

interface BreakdownTaskInput extends ToolModelOverrides {
  taskId?: string;
  goal?: string;
}

interface BreakdownTaskWorkflowDeps {
  repoDir?: string;
  taskStore: TaskStore;
  interactions?: InteractionStore;
  configStore?: ConfigStore;
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

interface GeneratePlanWorkflowDeps extends ToolModelOverrides {
  repoDir: string;
  taskStore: TaskStore;
  interactions: InteractionStore;
  configStore: ConfigStore;
  registry: ToolPluginRegistry;
  memory?: MemoryStore;
  feedback?: string;
}

interface GeneratePlanWorkflowResult {
  taskId: string;
  plan: string;
  interactionId: string;
  tool: string;
  model: string;
  memory?: BudgetedRetrievalResult;
}

interface RequestPlanChangesWorkflowDeps
  extends Omit<GeneratePlanWorkflowDeps, 'feedback'> {
  interactionId?: string;
}

interface RequestPlanChangesWorkflowResult extends GeneratePlanWorkflowResult {
  reviewId: string;
}

export async function evaluateTaskWorkflow(
  taskID: string,
  deps: EvaluateTaskWorkflowDeps,
): Promise<TaskEvaluation> {
  const task = await getTask(taskID, deps.taskStore);
  const config = await deps.configStore.load();

  return await evaluateTask(task, {
    repoDir: deps.repoDir,
    config,
    registry: deps.registry,
    interactions: deps.interactions,
    toolOverride: deps.toolOverride ?? '',
    modelOverride: deps.modelOverride ?? '',
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

  let task: Task | null = null;
  if (taskID) {
    task = await getTask(taskID, deps.taskStore);
  }

  const title = task?.title ?? goal;
  const description = task?.description ?? '';

  if (canRunLLMBreakdown(deps)) {
    const config = await deps.configStore.load();
    const memoryResult = await retrievePlanningMemory({
      repoDir: deps.repoDir,
      taskStore: deps.taskStore,
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

  const proposed = task
    ? generateProposedSubtasks(task.title, task.description ?? '')
    : generateGlobalPlan(goal);

  return {
    taskId: task?.id,
    proposed: normalizeProposedTasks(proposed),
  };
}

export async function acceptBreakdown(
  parentID: string | null,
  proposals: ProposedTask[],
  deps: { taskStore: TaskStore; queue?: JobQueue },
): Promise<AcceptBreakdownResult> {
  const normalizedParentID = (parentID ?? '').trim();
  if (normalizedParentID) {
    await getTask(normalizedParentID, deps.taskStore);
  }

  const normalizedProposals = normalizeProposedTasks(proposals);
  const createdIDs: string[] = [];

  for (const item of normalizedProposals) {
    const created = await deps.taskStore.create({
      title: item.title,
      description: item.description,
      parentId: normalizedParentID || null,
    });
    createdIDs.push(created.id);
  }

  // Set deps before enqueueing evaluate so dep checks work
  for (const [index, item] of normalizedProposals.entries()) {
    const taskID = createdIDs[index];
    const dependencyIDs = (item.dependsOnIndices ?? [])
      .map((depIndex) => createdIDs[depIndex] ?? '')
      .filter(Boolean);
    if (dependencyIDs.length > 0) {
      await deps.taskStore.updateDependencies(taskID!, dependencyIDs);
    }
  }

  // Only enqueue evaluate for tasks with all deps met (or no deps)
  if (deps.queue) {
    for (const taskId of createdIDs) {
      const met = await deps.taskStore.areDependenciesMet(taskId);
      if (met) {
        await deps.queue.enqueue({
          type: 'evaluate',
          taskId,
          priority: JOB_PRIORITIES.evaluate,
        });
      }
    }
  }

  if (normalizedParentID) {
    await deps.taskStore.updateStatus(
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
    qualityJson: JSON.stringify({ taskId: taskID, rejected: true }),
  });
}

export async function generatePlan(
  taskID: string,
  deps: GeneratePlanWorkflowDeps,
): Promise<GeneratePlanWorkflowResult> {
  const task = await getTask(taskID, deps.taskStore);
  const config = await deps.configStore.load();
  const memoryResult = await retrievePlanningMemory({
    repoDir: deps.repoDir,
    taskStore: deps.taskStore,
    memory: deps.memory,
    taskId: task.id,
    title: task.title,
    description: task.description ?? '',
    config,
    registry: deps.registry,
    interactions: deps.interactions,
  });

  const result = await runPlan({
    repoDir: deps.repoDir,
    taskID,
    title: task.title,
    description: task.description ?? '',
    feedback: deps.feedback?.trim() || undefined,
    memoryContext: memoryResult.memoryContext,
    config,
    registry: deps.registry,
    interactions: deps.interactions,
    toolOverride: deps.toolOverride ?? '',
    modelOverride: deps.modelOverride ?? '',
  });

  return {
    taskId: taskID,
    plan: result.plan,
    interactionId: result.interactionId,
    tool: result.tool,
    model: result.model,
    memory: memoryResult.memory ?? undefined,
  };
}

export async function approvePlan(
  taskID: string,
  deps: {
    taskStore: TaskStore;
    requirePendingStatus?: boolean;
  },
): Promise<Task> {
  const task = await getTask(taskID, deps.taskStore);

  if (deps.requirePendingStatus && task.status !== TASK_STATUSES.pending) {
    throw new Error(`task ${taskID} is ${task.status}; expected pending`);
  }
  if (!(task.plan ?? '').trim()) {
    throw new Error('task plan is empty');
  }

  return await deps.taskStore.updateStatus(taskID, TASK_STATUSES.planned);
}

export async function requestPlanChanges(
  taskID: string,
  feedback: string,
  deps: RequestPlanChangesWorkflowDeps,
): Promise<RequestPlanChangesWorkflowResult> {
  const normalizedFeedback = feedback.trim();
  if (!normalizedFeedback) {
    throw new Error('feedback is required');
  }

  await getTask(taskID, deps.taskStore);
  const reviewID = await deps.taskStore.addReview(
    taskID,
    normalizedFeedback,
    deps.interactionId ?? '',
  );

  const result = await generatePlan(taskID, {
    ...deps,
    feedback: normalizedFeedback,
  });

  await deps.taskStore.setPlan(taskID, result.plan);
  await deps.taskStore.addressReview(reviewID);

  return {
    ...result,
    reviewId: reviewID,
  };
}

export async function loadProposedTasksFromInteraction(
  interactionID: string,
  deps: { interactions: InteractionStore },
): Promise<ProposedTask[]> {
  const normalizedInteractionID = interactionID.trim();
  if (!normalizedInteractionID) return [];

  const interaction = await deps.interactions.get(normalizedInteractionID);
  if (!interaction?.qualityJson) return [];

  try {
    const parsed = JSON.parse(interaction.qualityJson) as {
      proposed?: ProposedTask[];
    };
    if (!Array.isArray(parsed.proposed)) return [];
    return normalizeProposedTasks(parsed.proposed);
  } catch {
    return [];
  }
}

async function retrievePlanningMemory(input: {
  repoDir: string;
  taskStore: TaskStore;
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

  const memory = await retrieveBudgetedMemory(memoryStore, input.taskStore, {
    taskId: input.taskId,
    title: input.title,
    description: input.description,
    filePaths: input.taskId
      ? await input.taskStore.getFilePaths(input.taskId)
      : [],
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
  configStore: ConfigStore;
  registry: ToolPluginRegistry;
} {
  return Boolean(
    deps.repoDir && deps.interactions && deps.configStore && deps.registry,
  );
}

async function getTask(taskID: string, taskStore: TaskStore): Promise<Task> {
  const task = await taskStore.get(taskID);
  if (!task) {
    throw new Error(`task not found: ${taskID}`);
  }
  return task;
}
