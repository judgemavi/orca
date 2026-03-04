import {
  cleanupTaskArtifacts,
  type TaskCleanupResult,
} from '../domain/task-cleanup';
import type { JobQueue } from '../queue/queue';
import { toErrorMessage } from '../shared/errors';
import type { InteractionStore } from '../store/interactions';
import type { TaskStore } from '../store/tasks';

export interface DeleteTaskResult {
  taskId: string;
  deleted: boolean;
  cleanup: TaskCleanupResult;
}

export class DeleteWorkflowError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404,
  ) {
    super(message);
    this.name = 'DeleteWorkflowError';
  }
}

export async function deleteTask(
  taskID: string,
  deps: {
    taskStore: TaskStore;
    interactions: InteractionStore;
    repoDir: string;
    queue?: JobQueue;
  },
): Promise<DeleteTaskResult> {
  const normalizedTaskID = taskID.trim();
  if (!normalizedTaskID) {
    throw new DeleteWorkflowError('task id required', 400);
  }

  const task = await deps.taskStore.get(normalizedTaskID);
  if (!task) {
    throw new DeleteWorkflowError('task not found', 404);
  }

  if (deps.queue) {
    await deps.queue.cancelForTask(normalizedTaskID);
  }

  try {
    await deps.taskStore.delete(normalizedTaskID);
  } catch (error) {
    throw new DeleteWorkflowError(toErrorMessage(error), 400);
  }

  const cleanup = await cleanupTaskArtifacts({
    repoDir: deps.repoDir,
    taskID: normalizedTaskID,
    removeLogs: () => deps.interactions.removeTaskLogs(normalizedTaskID),
  });

  return {
    taskId: normalizedTaskID,
    deleted: true,
    cleanup,
  };
}
