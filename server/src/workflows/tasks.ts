import { resumeChain } from '../queue/chain';
import type { JobQueue } from '../queue/queue';
import type { ConfigStore } from '../store/config';
import type { InteractionStore } from '../store/interactions';
import type { TaskStore } from '../store/tasks';
import type { AutoRunOverrides, Task, TaskStatus } from '../types';
import { INTERACTION_STATUSES, JOB_PRIORITIES, TASK_STATUSES } from '../types';

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

export function validateManualStatusTransition(
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
  taskStore: TaskStore;
  queue?: JobQueue;
  configStore?: ConfigStore;
}

interface EnqueueDeps {
  taskStore: TaskStore;
  queue: JobQueue;
}

interface ToolModelOpts {
  tool?: string;
  model?: string;
}

interface EnqueueResult {
  taskId: string;
  jobId: string;
}

function requireQueue(deps: { queue?: JobQueue }): JobQueue {
  if (!deps.queue) throw new Error('queue is required (is daemon running?)');
  return deps.queue;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface CreateTaskInput {
  id?: string;
  title: string;
  description?: string;
  parentId?: string | null;
  dependsOn?: string[];
  autoRunOverrides?: AutoRunOverrides;
}

export async function createTask(
  input: CreateTaskInput,
  deps: TaskWorkflowDeps,
): Promise<Task> {
  const task = await deps.taskStore.create({
    id: input.id,
    title: input.title,
    description: input.description ?? '',
    parentId: input.parentId ?? null,
    autoRunOverrides: input.autoRunOverrides,
  });

  const hasDeps = Array.isArray(input.dependsOn) && input.dependsOn.length > 0;
  if (hasDeps) {
    const cleaned = input.dependsOn!.map((v) => v.trim()).filter(Boolean);
    await deps.taskStore.updateDependencies(task.id, cleaned);
  }

  if (deps.queue && !hasDeps) {
    await deps.queue.enqueue({
      type: 'evaluate',
      taskId: task.id,
      priority: JOB_PRIORITIES.evaluate,
    });
  }

  return (await deps.taskStore.get(task.id))!;
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export interface UpdateTaskInput {
  taskId: string;
  title?: string;
  description?: string;
  plan?: string;
  status?: string;
  sessionId?: string | null;
  dependsOn?: string[];
  autoRunOverrides?: AutoRunOverrides;
}

export async function updateTask(
  input: UpdateTaskInput,
  deps: TaskWorkflowDeps,
): Promise<Task> {
  const existing = await deps.taskStore.get(input.taskId);
  if (!existing) throw new Error(`task not found: ${input.taskId}`);

  if (input.status !== undefined) {
    const err = validateManualStatusTransition(existing.status, input.status);
    if (err) throw new Error(err);
  }

  if (Array.isArray(input.dependsOn)) {
    const cleaned = input.dependsOn.map((v) => v.trim()).filter(Boolean);
    await deps.taskStore.updateDependencies(input.taskId, cleaned);
  }

  await deps.taskStore.update(input.taskId, {
    title: input.title,
    description: input.description,
    plan: input.plan,
    status: input.status as TaskStatus | undefined,
    sessionId: input.sessionId,
    autoRunOverrides: input.autoRunOverrides,
  });

  const updated = await deps.taskStore.get(input.taskId);
  if (!updated) throw new Error(`task not found: ${input.taskId}`);

  if (input.status && deps.queue && deps.configStore) {
    await resumeChain(input.taskId, input.status as TaskStatus, {
      configStore: deps.configStore,
      taskStore: deps.taskStore,
      queue: deps.queue,
    });
  }

  return updated;
}

// ---------------------------------------------------------------------------
// Provide input (answer pending question)
// ---------------------------------------------------------------------------

export interface ProvideInputResult {
  taskId: string;
  jobId?: string;
}

export async function provideInput(
  taskId: string,
  answer: string,
  deps: TaskWorkflowDeps,
): Promise<ProvideInputResult> {
  const task = await deps.taskStore.get(taskId);
  if (!task) throw new Error(`task not found: ${taskId}`);
  if (!task.pendingQuestion) {
    throw new Error('task has no pending question');
  }

  const trimmed = answer.trim();
  if (!trimmed) throw new Error('answer is required');

  const updatedDescription = task.description
    ? `${task.description}\n\n---\n**User clarification:** ${trimmed}`
    : `**User clarification:** ${trimmed}`;

  await deps.taskStore.update(taskId, {
    description: updatedDescription,
    pendingQuestion: null,
    status: 'pending',
  });

  let jobId: string | undefined;
  if (deps.queue) {
    const job = await deps.queue.enqueue({
      type: 'evaluate',
      taskId,
      priority: JOB_PRIORITIES.evaluate,
    });
    jobId = job.id;
  }

  return { taskId, jobId };
}

// ---------------------------------------------------------------------------
// Request changes (review rejection → enqueue code)
// ---------------------------------------------------------------------------

export async function requestChanges(
  taskId: string,
  feedback: string,
  deps: {
    taskStore: TaskStore;
    interactionStore: InteractionStore;
    queue: JobQueue;
    interactionId?: string;
    tool?: string;
    model?: string;
  },
): Promise<EnqueueResult & { reviewId: string }> {
  const trimmed = feedback.trim();
  if (!trimmed) throw new Error('feedback is required');

  const task = await deps.taskStore.get(taskId);
  if (!task) throw new Error(`task not found: ${taskId}`);
  if (task.status !== TASK_STATUSES.review) {
    throw new Error('task must be in review status to request changes');
  }

  const reviewId = await deps.taskStore.addReview(
    taskId,
    trimmed,
    deps.interactionId ?? '',
  );
  await deps.interactionStore.supersedeReviewInteractions(taskId);

  const { id: jobId } = await deps.queue.enqueue({
    type: 'code',
    taskId,
    priority: JOB_PRIORITIES.code,
    payload: { tool: deps.tool ?? '', model: deps.model ?? '' },
  });

  return { taskId, jobId, reviewId };
}

// ---------------------------------------------------------------------------
// Trigger AI review (enqueue review job)
// ---------------------------------------------------------------------------

export async function triggerReview(
  taskId: string,
  opts: ToolModelOpts & { prompt?: string },
  deps: {
    taskStore: TaskStore;
    interactionStore: InteractionStore;
    queue: JobQueue;
  },
): Promise<EnqueueResult> {
  const task = await deps.taskStore.get(taskId);
  if (!task) throw new Error(`task not found: ${taskId}`);
  if (task.status !== TASK_STATUSES.review) {
    throw new Error(
      `task must be in review status, got ${JSON.stringify(task.status)}`,
    );
  }

  const codeInteractions = await deps.interactionStore.listByType(
    taskId,
    'code',
  );
  const latest = codeInteractions.find(
    (ix) =>
      ix.status === INTERACTION_STATUSES.completed && Boolean(ix.diff?.trim()),
  );
  if (!latest?.diff?.trim()) {
    throw new Error('no completed run interaction with diff found');
  }

  const { id: jobId } = await deps.queue.enqueue({
    type: 'review',
    taskId,
    priority: JOB_PRIORITIES.review,
    payload: {
      prompt: opts.prompt ?? '',
      tool: opts.tool ?? '',
      model: opts.model ?? '',
    },
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
    priority: JOB_PRIORITIES.evaluate,
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
  const task = await deps.taskStore.get(taskId);
  if (!task) throw new Error(`task not found: ${taskId}`);

  const { id: jobId } = await deps.queue.enqueue({
    type: 'breakdown',
    taskId,
    priority: JOB_PRIORITIES.breakdown,
    payload: { tool: opts.tool ?? '', model: opts.model ?? '' },
  });
  return { taskId, jobId };
}

// ---------------------------------------------------------------------------
// Enqueue merge
// ---------------------------------------------------------------------------

export async function enqueueMerge(
  taskId: string,
  deps: EnqueueDeps,
): Promise<EnqueueResult> {
  const task = await deps.taskStore.get(taskId);
  if (!task) throw new Error(`task not found: ${taskId}`);

  const { id: jobId } = await deps.queue.enqueue({
    type: 'merge',
    taskId,
    priority: JOB_PRIORITIES.merge,
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
  const task = await deps.taskStore.get(taskId);
  if (!task) throw new Error(`task not found: ${taskId}`);

  await deps.queue.cancelForTask(taskId);

  if (task.status === 'running') {
    await deps.taskStore.updateStatus(taskId, TASK_STATUSES.stopped);
  }

  return { taskId, status: 'stopped' };
}

// ---------------------------------------------------------------------------
// Resume task (enqueue code with feedback to continue from session)
// ---------------------------------------------------------------------------

export async function resumeTask(
  taskId: string,
  feedback: string,
  opts: ToolModelOpts,
  deps: EnqueueDeps,
): Promise<EnqueueResult> {
  const task = await deps.taskStore.get(taskId);
  if (!task) throw new Error(`task not found: ${taskId}`);
  if (task.status !== TASK_STATUSES.stopped) {
    throw new Error(`task ${taskId} is "${task.status}", not "stopped"`);
  }

  const { id: jobId } = await deps.queue.enqueue({
    type: 'code',
    taskId,
    priority: JOB_PRIORITIES.code,
    payload: {
      feedback: feedback.trim(),
      tool: opts.tool ?? '',
      model: opts.model ?? '',
    },
  });

  return { taskId, jobId };
}
