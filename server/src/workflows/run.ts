import { TASK_STATUSES } from '@orca/types';
import type { EventSink } from '../api/ws';
import type { OrcaDrizzleDB } from '../db/connection';
import type { Executor, RunOptions } from '../executor/executor';
import type { TaskRunResult } from '../executor/task-runner';
import type { InteractionStore } from '../store/interactions';
import * as taskStore from '../store/tasks';

export interface RunOpts {
  toolOverride?: string;
  modelOverride?: string;
  context?: string;
}

type TaskResult = TaskRunResult;

type RunWorkflowError = Error & { status: 400 | 404 };

function runWorkflowError(
  message: string,
  status: 400 | 404,
): RunWorkflowError {
  const err = new Error(message) as RunWorkflowError;
  err.name = 'RunWorkflowError';
  err.status = status;
  return err;
}

export function isRunWorkflowError(err: unknown): err is RunWorkflowError {
  return err instanceof Error && err.name === 'RunWorkflowError';
}

export async function resumeTask(
  executor: Executor,
  db: OrcaDrizzleDB,
  taskID: string,
  feedback = '',
  opts: RunOpts = {},
  interactionStore?: InteractionStore,
): Promise<TaskResult> {
  const normalizedTaskID = taskID.trim();
  if (!normalizedTaskID) {
    throw runWorkflowError('task id required', 400);
  }

  let task: Awaited<ReturnType<typeof taskStore.getTask>> | null = null;
  try {
    task = await taskStore.getTask(db, normalizedTaskID);
  } catch {
    throw runWorkflowError('task not found', 404);
  }
  if (task.status !== TASK_STATUSES.stopped) {
    throw runWorkflowError(
      `task ${normalizedTaskID} is "${task.status}", not "stopped"`,
      400,
    );
  }
  const sessionId =
    await interactionStore?.getLatestSessionId(normalizedTaskID);
  if (!sessionId?.trim()) {
    throw runWorkflowError(
      `task ${normalizedTaskID} cannot resume without sessionId`,
      400,
    );
  }

  return await executor.resumeTask(
    normalizedTaskID,
    feedback,
    toRunOptions(opts),
  );
}

export async function stopTask(
  executor: Executor,
  db: OrcaDrizzleDB,
  sink: EventSink | undefined,
  taskID: string,
): Promise<void> {
  const normalizedTaskID = taskID.trim();
  if (!normalizedTaskID) {
    throw runWorkflowError('task id required', 400);
  }

  const stopped = executor.stopTask(normalizedTaskID);
  if (!stopped) {
    throw runWorkflowError('task not running', 404);
  }

  try {
    await taskStore.updateTask(db, sink, normalizedTaskID, {
      status: TASK_STATUSES.stopped,
    });
  } catch (error) {
    const message = String(error);
    if (message.includes('not found')) {
      throw runWorkflowError('task not found', 404);
    }
    throw error;
  }
}

function toRunOptions(opts: RunOpts): RunOptions {
  return {
    toolOverride: opts.toolOverride ?? '',
    modelOverride: opts.modelOverride ?? '',
    context: opts.context ?? '',
  };
}
