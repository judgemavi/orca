import { TASK_STATUSES } from '@orca/server/types';
import { useMemo } from 'react';
import type { Task } from '../../types';

interface TaskListStats {
  totalTasks: number;
  pendingCount: number;
  plannedCount: number;
  runningCount: number;
  reviewCount: number;
  approvedCount: number;
  brokenDownCount: number;
  mergedCount: number;
  failedCount: number;
  hasApprovedTasks: boolean;
}

export function useTaskListStats(tasks: Task[]): TaskListStats {
  return useMemo(() => {
    const stats: TaskListStats = {
      totalTasks: tasks.length,
      pendingCount: 0,
      plannedCount: 0,
      runningCount: 0,
      reviewCount: 0,
      approvedCount: 0,
      brokenDownCount: 0,
      mergedCount: 0,
      failedCount: 0,
      hasApprovedTasks: false,
    };

    for (const task of tasks) {
      if (task.status === TASK_STATUSES.pending) stats.pendingCount += 1;
      if (task.status === TASK_STATUSES.planned) stats.plannedCount += 1;
      if (task.status === TASK_STATUSES.running) stats.runningCount += 1;
      if (task.status === TASK_STATUSES.review) stats.reviewCount += 1;
      if (task.status === TASK_STATUSES.approved) stats.approvedCount += 1;
      if (task.status === TASK_STATUSES.broken_down) stats.brokenDownCount += 1;
      if (task.status === TASK_STATUSES.merged) stats.mergedCount += 1;
      if (task.status === TASK_STATUSES.failed) stats.failedCount += 1;
    }

    stats.hasApprovedTasks = stats.approvedCount > 0;
    return stats;
  }, [tasks]);
}
