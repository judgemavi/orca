import { JOB_PRIORITIES } from '@orca/types';
import type { EventSink } from '../api/ws';
import type { OrcaDrizzleDB } from '../db/connection';
import {
  cleanupTaskArtifacts,
  type TaskCleanupResult,
} from '../domain/task-cleanup';
import type { JobQueue } from '../queue/queue';
import { toErrorMessage } from '../shared/errors';
import { log } from '../shared/logger';
import type { InteractionStore } from '../store/interactions';
import * as taskStore from '../store/tasks';

interface DeleteTaskResult {
  taskId: string;
  deleted: boolean;
  unblockedTasks: string[];
  cleanup: TaskCleanupResult;
}

type DeleteWorkflowError = Error & { status: 400 | 404 };

function deleteWorkflowError(
  message: string,
  status: 400 | 404,
): DeleteWorkflowError {
  const err = new Error(message) as DeleteWorkflowError;
  err.name = 'DeleteWorkflowError';
  err.status = status;
  return err;
}

export function isDeleteWorkflowError(
  err: unknown,
): err is DeleteWorkflowError {
  return err instanceof Error && err.name === 'DeleteWorkflowError';
}

export async function deleteTask(
  taskID: string,
  deps: {
    db: OrcaDrizzleDB;
    sink?: EventSink;
    interactions: InteractionStore;
    repoDir: string;
    queue?: JobQueue;
  },
): Promise<DeleteTaskResult> {
  const normalizedTaskID = taskID.trim();
  if (!normalizedTaskID) {
    throw deleteWorkflowError('task id required', 400);
  }

  try {
    await taskStore.getTask(deps.db, normalizedTaskID);
  } catch {
    throw deleteWorkflowError('task not found', 404);
  }

  if (deps.queue) {
    await deps.queue.cancelForTask(normalizedTaskID);
  }

  const unblockedTasks = await taskStore.getUnblockedDependents(
    deps.db,
    normalizedTaskID,
  );

  try {
    await taskStore.deleteTask(deps.db, deps.sink, normalizedTaskID);
  } catch (error) {
    throw deleteWorkflowError(toErrorMessage(error), 400);
  }

  const unblockedIds = unblockedTasks.map((t) => t.id);

  // Re-enqueue tasks that were blocked on the deleted dep
  if (deps.queue && unblockedIds.length > 0) {
    for (const depTaskId of unblockedIds) {
      let depTask: Awaited<ReturnType<typeof taskStore.getTask>> | null = null;
      try {
        depTask = await taskStore.getTask(deps.db, depTaskId);
      } catch {
        continue;
      }
      const met = await taskStore.areDependenciesMet(deps.db, depTaskId);
      if (!met) continue;

      // If task has a currentStep, it already ran evaluate and is waiting at the gate
      const jobType = depTask.currentStep ?? 'evaluate';
      const priority =
        JOB_PRIORITIES[jobType as keyof typeof JOB_PRIORITIES] ??
        JOB_PRIORITIES.evaluate;

      log.info('unblocked task after dependency deleted', {
        taskId: depTaskId,
        deletedDep: normalizedTaskID,
        enqueueing: jobType,
      });
      await deps.queue.enqueue({
        type: jobType,
        taskId: depTaskId,
        priority,
      });
    }
  }

  const cleanup = await cleanupTaskArtifacts({
    repoDir: deps.repoDir,
    taskID: normalizedTaskID,
    removeLogs: () => deps.interactions.removeTaskLogs(normalizedTaskID),
  });

  return {
    taskId: normalizedTaskID,
    deleted: true,
    unblockedTasks: unblockedIds,
    cleanup,
  };
}
