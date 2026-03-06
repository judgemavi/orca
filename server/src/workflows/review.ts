import { runAIReview } from '../domain/review';
import type { Executor } from '../executor/executor';
import type { TaskRunResult } from '../executor/task-runner';
import type { ToolPluginRegistry } from '../plugin/registry';
import type { ConfigStore } from '../store/config';
import type { InteractionStore } from '../store/interactions';
import type { TaskStore } from '../store/tasks';
import type { Task } from '../types';
import { INTERACTION_STATUSES, TASK_STATUSES } from '../types';

export interface RequestChangesWorkflowDeps {
  taskStore: TaskStore;
  interactions: InteractionStore;
  executor: Executor;
  interactionId?: string;
  opts?: {
    toolOverride?: string;
    modelOverride?: string;
  };
}

export interface RequestChangesWorkflowResult {
  taskId: string;
  reviewId: string;
  result: TaskRunResult;
}

export interface RunAIReviewWorkflowDeps {
  repoDir: string;
  configStore: ConfigStore;
  registry: ToolPluginRegistry;
  taskStore: TaskStore;
  interactions: InteractionStore;
  prompt?: string;
  toolOverride?: string;
  modelOverride?: string;
}

export interface RunAIReviewWorkflowResult {
  taskId: string;
  approved: boolean;
  feedback: string;
  tool: string;
  model: string;
  interactionId: string;
  prompt: string;
  reviewId?: string;
  checks: import('../types').AIReviewCheck[];
  findings: import('../types').AIReviewFinding[];
}

export async function approveTask(
  taskID: string,
  deps: { taskStore: TaskStore },
): Promise<Task> {
  await getTaskInReview(taskID, deps.taskStore, 'task must be in review');
  return await deps.taskStore.updateStatus(taskID, TASK_STATUSES.approved);
}

export async function requestChanges(
  taskID: string,
  feedback: string,
  deps: RequestChangesWorkflowDeps,
): Promise<RequestChangesWorkflowResult> {
  const normalizedFeedback = feedback.trim();
  if (!normalizedFeedback) {
    throw new Error('feedback is required');
  }

  await getTaskInReview(taskID, deps.taskStore, 'task must be in review');

  const reviewID = await deps.taskStore.addReview(
    taskID,
    normalizedFeedback,
    deps.interactionId ?? '',
  );
  await deps.interactions.supersedeReviewInteractions(taskID);

  const result = await deps.executor.runTaskByID(taskID, {
    toolOverride: deps.opts?.toolOverride ?? '',
    modelOverride: deps.opts?.modelOverride ?? '',
  });

  return {
    taskId: taskID,
    reviewId: reviewID,
    result,
  };
}

export async function runAIReviewWorkflow(
  taskID: string,
  deps: RunAIReviewWorkflowDeps,
): Promise<RunAIReviewWorkflowResult> {
  const task = await getTaskInReview(
    taskID,
    deps.taskStore,
    (current) =>
      `task must be in review status, got ${JSON.stringify(current.status)}`,
  );

  const runInteractions = await deps.interactions.listByType(taskID, 'code');
  const latest = runInteractions.find(
    (item) =>
      item.status === INTERACTION_STATUSES.completed &&
      Boolean(item.diff?.trim()),
  );
  const diff = latest?.diff?.trim() ?? '';
  if (!diff) {
    throw new Error('no completed run interaction with diff found');
  }

  const review = await runAIReview({
    repoDir: deps.repoDir,
    taskID,
    title: task.title,
    description: task.description ?? '',
    diff,
    prompt: deps.prompt ?? '',
    config: await deps.configStore.load(),
    registry: deps.registry,
    interactions: deps.interactions,
    toolOverride: deps.toolOverride ?? '',
    modelOverride: deps.modelOverride ?? '',
  });

  let reviewID = '';
  if (!review.approved) {
    reviewID = await deps.taskStore.addReview(
      taskID,
      review.feedback,
      review.interactionId,
    );
  }

  return {
    ...review,
    reviewId: reviewID || undefined,
  };
}

async function getTaskInReview(
  taskID: string,
  taskStore: TaskStore,
  message: string | ((task: Task) => string),
): Promise<Task> {
  const task = await taskStore.get(taskID);
  if (!task) throw new Error(`task not found: ${taskID}`);
  if (task.status !== TASK_STATUSES.review) {
    if (typeof message === 'string') {
      throw new Error(message);
    }
    throw new Error(message(task));
  }
  return task;
}
