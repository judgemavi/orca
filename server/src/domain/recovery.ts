import { INTERACTION_STATUSES, TASK_STATUSES } from '@orca/types';
import type { OrcaDrizzleDB } from '../db/connection';
import type { JobQueue } from '../queue/queue';
import type { InteractionStore } from '../store/interactions';
import * as taskStore from '../store/tasks';

interface RecoverySummary {
  interactionsFailed: number;
  tasksStopped: number;
  tasksFailed: number;
}

export async function failInFlightForShutdown(
  db: OrcaDrizzleDB,
  interactions: InteractionStore,
  log: (event: string, data?: Record<string, unknown>) => void = () => {},
): Promise<RecoverySummary> {
  let interactionsFailed = 0;
  let tasksStopped = 0;
  let tasksFailed = 0;

  const runningInteractions = await interactions.listByStatus(
    INTERACTION_STATUSES.running,
  );
  for (const item of runningInteractions) {
    await interactions.finish(item.id, {
      status: INTERACTION_STATUSES.failed,
      error: 'shutdown signal received',
    });
    interactionsFailed += 1;

    if (item.taskId?.trim() && item.type === 'code') {
      const task = await taskStore.getTask(db, item.taskId);
      if (task && task.status === TASK_STATUSES.running) {
        const sessionId = await interactions.getLatestSessionId(task.id);
        const next = sessionId ? 'stopped' : 'failed';
        await taskStore.updateTask(db, undefined, task.id, { status: next });
        if (next === TASK_STATUSES.stopped) tasksStopped += 1;
        else tasksFailed += 1;
      }
    }

    log('shutdown.recovery.interaction.failed', {
      interactionId: item.id,
      taskId: item.taskId ?? '',
      type: item.type,
    });
  }

  const runningTasks = await taskStore.listTasks(db, TASK_STATUSES.running);
  for (const task of runningTasks) {
    const sessionId = await interactions.getLatestSessionId(task.id);
    const next = sessionId ? TASK_STATUSES.stopped : TASK_STATUSES.failed;
    await taskStore.updateTask(db, undefined, task.id, { status: next });
    if (next === TASK_STATUSES.stopped) tasksStopped += 1;
    else tasksFailed += 1;
    log('shutdown.recovery.task.reset', {
      taskId: task.id,
      toStatus: next,
    });
  }

  const summary = {
    interactionsFailed: interactionsFailed,
    tasksStopped: tasksStopped,
    tasksFailed: tasksFailed,
  };
  if (interactionsFailed > 0 || tasksStopped > 0 || tasksFailed > 0) {
    log('shutdown.recovery.complete', summary);
  }
  return summary;
}

export async function runStartupRecovery(
  db: OrcaDrizzleDB,
  interactions: InteractionStore,
  log: (event: string, data?: Record<string, unknown>) => void = () => {},
  queue?: JobQueue,
): Promise<RecoverySummary> {
  let interactionsFailed = 0;
  let tasksStopped = 0;
  let tasksFailed = 0;

  const runningInteractions = await interactions.listByStatus(
    INTERACTION_STATUSES.running,
  );
  for (const item of runningInteractions) {
    await interactions.finish(item.id, {
      status: INTERACTION_STATUSES.failed,
      error: item.error?.trim() || 'unclean shutdown',
    });
    interactionsFailed += 1;
    log('startup.recovery.interaction.failed', {
      interactionId: item.id,
      taskId: item.taskId ?? '',
      type: item.type,
    });
  }

  if (queue) {
    const requeued = await queue.requeueRunning();
    if (requeued > 0) {
      log('startup.recovery.jobs.requeued', { count: requeued });
    }
  } else {
    // Without queue: fall back to resetting task statuses directly
    const runningTasks = await taskStore.listTasks(db, TASK_STATUSES.running);
    for (const task of runningTasks) {
      const sessionId = await interactions.getLatestSessionId(task.id);
      const next = sessionId ? 'stopped' : 'failed';
      await taskStore.updateTask(db, undefined, task.id, { status: next });

      if (next === TASK_STATUSES.stopped) tasksStopped += 1;
      else tasksFailed += 1;

      log('startup.recovery.task.reset', {
        taskId: task.id,
        fromStatus: TASK_STATUSES.running,
        toStatus: next,
        resumable: Boolean(sessionId),
      });
    }
  }

  const summary = {
    interactionsFailed: interactionsFailed,
    tasksStopped: tasksStopped,
    tasksFailed: tasksFailed,
  };
  if (interactionsFailed > 0 || tasksStopped > 0 || tasksFailed > 0) {
    log('startup.recovery.complete', summary);
  }
  return summary;
}
