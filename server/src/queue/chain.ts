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
