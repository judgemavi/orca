import {
  SYSTEM_JOB_PRIORITIES,
  TASK_STATUSES,
  type TaskStatus,
} from '@orca/types';
import { nanoid } from 'nanoid';
import type { EventSink } from '../api/ws';
import type { OrcaDrizzleDB } from '../db/connection';
import type {
  CreateTaskInput as DBCreateTaskInput,
  UpdateTaskInput as DBUpdateTaskInput,
  TaskEntry,
} from '../db/schema';
import type { JobQueue } from '../queue/queue';
import type { InteractionStore } from '../store/interactions';
import * as questionStore from '../store/questions';
import * as taskStore from '../store/tasks';
import { resolveStepMeta } from '../workflow/paths';
import type { WorkflowStore } from '../workflow/store';

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const BLOCKED_MANUAL_STATUSES = new Set<TaskStatus>([
  'planned',
  'approved',
  'running',
  'merged',
  'review',
]);

function validateManualStatusTransition(
  current: TaskStatus,
  next: string,
): string | null {
  const status = next.trim() as TaskStatus;
  if (!status) return 'status must be a string';
  if (status === 'pending' && current !== 'failed') {
    return 'can only move failed tasks to pending';
  }
  if (status === 'stopped' || status === 'failed' || status === 'pending') {
    return null;
  }
  if (BLOCKED_MANUAL_STATUSES.has(status)) {
    return `cannot manually set status to ${status}`;
  }
  return `cannot manually set status to ${status}`;
}

// ---------------------------------------------------------------------------
// Shared deps
// ---------------------------------------------------------------------------

interface TaskWorkflowDeps {
  db: OrcaDrizzleDB;
  sink?: EventSink;
  queue?: JobQueue;
  workflowStore?: WorkflowStore;
}

interface EnqueueDeps {
  db: OrcaDrizzleDB;
  sink?: EventSink;
  queue: JobQueue;
  workflowStore?: WorkflowStore;
}

interface ToolModelOpts {
  tool?: string;
  model?: string;
}

interface EnqueueResult {
  taskId: string;
  jobId: string;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

type CreateTaskInput = Pick<
  DBCreateTaskInput,
  | 'id'
  | 'title'
  | 'description'
  | 'parentId'
  | 'dependsOn'
  | 'autoRunOverrides'
  | 'workflow'
>;

export async function createTask(
  input: CreateTaskInput,
  deps: TaskWorkflowDeps,
): Promise<TaskEntry> {
  const { db, sink } = deps;
  const id = input.id ?? nanoid();

  await taskStore.createTask(db, sink, {
    id,
    title: input.title,
    description: input.description ?? '',
    parentId: input.parentId ?? null,
    autoRunOverrides: input.autoRunOverrides ?? {},
    workflow: input.workflow,
    dependsOn: input.dependsOn,
  });

  const created = await taskStore.getTask(db, id);

  if (deps.queue) {
    await deps.queue.enqueue({
      type: 'evaluate',
      taskId: created.id,
      priority: SYSTEM_JOB_PRIORITIES.evaluate,
    });
  }

  return created;
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

type UpdateTaskInput = {
  taskId: string;
  dependsOn?: string[];
} & Pick<
  Partial<DBUpdateTaskInput>,
  'title' | 'description' | 'status' | 'autoRunOverrides'
>;

export async function updateTask(
  input: UpdateTaskInput,
  deps: TaskWorkflowDeps,
): Promise<TaskEntry> {
  const { db, sink } = deps;

  const existing = await taskStore.getTask(db, input.taskId).catch(() => null);
  if (!existing) throw new Error(`task not found: ${input.taskId}`);

  if (input.status !== undefined) {
    const err = validateManualStatusTransition(
      existing.status as TaskStatus,
      input.status,
    );
    if (err) throw new Error(err);
  }

  if (Array.isArray(input.dependsOn)) {
    const cleaned = input.dependsOn.map((v) => v.trim()).filter(Boolean);
    const currentDeps = existing.dependsOn ?? [];
    const toRemove = currentDeps.filter((d) => !cleaned.includes(d));
    const toAdd = cleaned.filter((d) => !currentDeps.includes(d));
    for (const depId of toRemove) {
      await taskStore.removeDependency(db, sink, input.taskId, depId);
    }
    for (const depId of toAdd) {
      await taskStore.addDependency(db, sink, input.taskId, depId);
    }
  }

  await taskStore.updateTask(db, sink, input.taskId, {
    title: input.title,
    description: input.description,
    status: input.status as TaskStatus | undefined,
    autoRunOverrides: input.autoRunOverrides,
  });

  return await taskStore.getTask(db, input.taskId);
}

// ---------------------------------------------------------------------------
// Provide input (answer pending question)
// ---------------------------------------------------------------------------

interface ProvideInputResult {
  taskId: string;
  jobId?: string;
}

export async function provideInput(
  taskId: string,
  answer: string,
  deps: TaskWorkflowDeps & {
    interactionStore: InteractionStore;
  },
): Promise<ProvideInputResult> {
  const { db, sink } = deps;

  const task = await taskStore.getTask(db, taskId).catch(() => null);
  if (!task) throw new Error(`task not found: ${taskId}`);

  let question: Awaited<ReturnType<typeof questionStore.getPendingForTask>>;
  try {
    question = await questionStore.getPendingForTask(db, taskId);
  } catch {
    throw new Error('task has no pending question');
  }

  const trimmed = answer.trim();
  if (!trimmed) throw new Error('answer is required');

  await questionStore.answerQuestion(db, question.id, trimmed);

  let resumeSessionID: string | undefined;
  if (question.interactionId) {
    const interaction = await deps.interactionStore.get(question.interactionId);
    resumeSessionID = interaction?.sessionId ?? undefined;
  }

  await taskStore.updateTask(db, sink, taskId, { status: 'pending' });

  let jobId: string | undefined;
  if (deps.queue) {
    const job = await deps.queue.enqueue({
      type: 'evaluate',
      taskId,
      priority: SYSTEM_JOB_PRIORITIES.evaluate,
      payload: {
        feedback: trimmed,
        ...(resumeSessionID ? { resumeSessionID } : {}),
      },
    });
    jobId = job.id;
  }

  return { taskId, jobId };
}

// ---------------------------------------------------------------------------
// Enqueue current step
// ---------------------------------------------------------------------------

export async function enqueueCurrentStep(
  taskId: string,
  payload: Record<string, unknown> | undefined,
  deps: EnqueueDeps,
): Promise<EnqueueResult> {
  const task = await taskStore.getTask(deps.db, taskId).catch(() => {
    throw new Error(`task not found: ${taskId}`);
  });
  if (!task.currentStep) throw new Error('task has no current step');

  let stepPriority = 5;
  if (deps.workflowStore) {
    try {
      const compiled = deps.workflowStore.resolve(task.workflow ?? undefined);
      stepPriority =
        resolveStepMeta(compiled.machine, task.currentStep).meta.priority ?? 5;
    } catch {}
  }
  const { id: jobId } = await deps.queue.enqueue({
    type: task.currentStep,
    taskId,
    priority: stepPriority,
    payload,
  });

  return { taskId, jobId };
}

// ---------------------------------------------------------------------------
// Enqueue evaluate
// ---------------------------------------------------------------------------

export async function enqueueEvaluate(
  taskId: string,
  opts: ToolModelOpts,
  deps: EnqueueDeps,
): Promise<EnqueueResult> {
  const { id: jobId } = await deps.queue.enqueue({
    type: 'evaluate',
    taskId,
    priority: SYSTEM_JOB_PRIORITIES.evaluate,
    payload: { tool: opts.tool ?? '', model: opts.model ?? '' },
  });
  return { taskId, jobId };
}

// ---------------------------------------------------------------------------
// Enqueue breakdown
// ---------------------------------------------------------------------------

export async function enqueueBreakdown(
  taskId: string,
  opts: ToolModelOpts,
  deps: EnqueueDeps,
): Promise<EnqueueResult> {
  await taskStore.getTask(deps.db, taskId).catch(() => {
    throw new Error(`task not found: ${taskId}`);
  });

  const { id: jobId } = await deps.queue.enqueue({
    type: 'breakdown',
    taskId,
    priority: SYSTEM_JOB_PRIORITIES.breakdown,
    payload: { tool: opts.tool ?? '', model: opts.model ?? '' },
  });
  return { taskId, jobId };
}

// ---------------------------------------------------------------------------
// Stop task (cancel queue + update status)
// ---------------------------------------------------------------------------

export async function stopTask(
  taskId: string,
  deps: EnqueueDeps,
): Promise<{ taskId: string; status: string }> {
  const { db, sink } = deps;

  const task = await taskStore.getTask(db, taskId).catch(() => {
    throw new Error(`task not found: ${taskId}`);
  });

  await deps.queue.cancelForTask(taskId);

  if (task.status === 'running') {
    await taskStore.updateTaskStatus(db, sink, taskId, TASK_STATUSES.stopped);
  }

  return { taskId, status: 'stopped' };
}
