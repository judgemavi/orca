import { isAutoRun } from '../config/config';
import { log } from '../shared/logger';
import type { ConfigStore } from '../store/config';
import type { TaskStore } from '../store/tasks';
import type { InteractionType, JobType, TaskStatus } from '../types';
import { JOB_PRIORITIES } from '../types';
import type { JobQueue } from './queue';

export interface ChainDeps {
  configStore: ConfigStore;
  taskStore: TaskStore;
  queue: JobQueue;
}

const STATUS_CHAIN: Partial<
  Record<TaskStatus, { jobType: JobType; interactionType: InteractionType }>
> = {
  planned: { jobType: 'code', interactionType: 'code' },
  approved: { jobType: 'merge', interactionType: 'merge' },
};

export async function resumeChain(
  taskId: string,
  newStatus: TaskStatus,
  deps: ChainDeps,
): Promise<void> {
  const next = STATUS_CHAIN[newStatus];
  if (!next) return;

  const [config, task] = await Promise.all([
    deps.configStore.load(),
    deps.taskStore.get(taskId),
  ]);
  if (!isAutoRun(config, next.interactionType, task?.autoRunOverrides)) return;

  const depsMet = await deps.taskStore.areDependenciesMet(taskId);
  if (!depsMet) {
    log.info('auto-chain skipped: dependencies not met', {
      taskId,
      status: newStatus,
      next: next.jobType,
    });
    return;
  }

  log.info('auto-chaining from status change', {
    taskId,
    status: newStatus,
    next: next.jobType,
  });
  await deps.queue.enqueue({
    type: next.jobType,
    taskId,
    priority: JOB_PRIORITIES[next.jobType],
  });
}

export async function unblockDependents(
  mergedTaskId: string,
  deps: ChainDeps,
): Promise<void> {
  const unblocked = await deps.taskStore.getUnblockedDependents(mergedTaskId);
  if (unblocked.length === 0) return;

  const config = await deps.configStore.load();

  for (const task of unblocked) {
    if (task.status === 'planned') {
      // Task already planned, resume chain to start code
      if (!isAutoRun(config, 'code', task.autoRunOverrides)) continue;
      log.info('unblocking planned task for code', {
        taskId: task.id,
        unblockedBy: mergedTaskId,
      });
      await deps.queue.enqueue({
        type: 'code',
        taskId: task.id,
        priority: JOB_PRIORITIES.code,
      });
    } else {
      // Task is pending, start from evaluate
      if (!isAutoRun(config, 'evaluate', task.autoRunOverrides)) continue;
      log.info('unblocking pending task for evaluate', {
        taskId: task.id,
        unblockedBy: mergedTaskId,
      });
      await deps.queue.enqueue({
        type: 'evaluate',
        taskId: task.id,
        priority: JOB_PRIORITIES.evaluate,
      });
    }
  }
}
