import { z } from 'zod';
import type { InteractionStore } from '../../store/interactions';
import type { MemoryStore } from '../../store/memory';
import type { TaskStore } from '../../store/tasks';
import { INTERACTION_STATUSES, TASK_STATUSES } from '../../types';
import { defineTool } from '../define-tool';
import type { Tool } from '../types';

const statusGetSchema = z.object({});

export function statusTools(deps: {
  taskStore: TaskStore;
  interactions: InteractionStore;
  memory: MemoryStore;
}): Tool[] {
  return [
    defineTool({
      name: 'status_get',
      description: 'Get project execution summary',
      schema: statusGetSchema,
      handler: async () => {
        const tasks = await deps.taskStore.list();
        const memory = await deps.memory.buildHealthSummary();
        return {
          totalTasks: tasks.length,
          pending: tasks.filter((task) => task.status === TASK_STATUSES.pending)
            .length,
          running: tasks.filter((task) => task.status === TASK_STATUSES.running)
            .length,
          failed: tasks.filter((task) => task.status === TASK_STATUSES.failed)
            .length,
          merged: tasks.filter((task) => task.status === TASK_STATUSES.merged)
            .length,
          runningOperations: (
            await deps.interactions.listByStatus(INTERACTION_STATUSES.running)
          ).length,
          totalCost: await deps.interactions.projectTotal(),
          memoryTotal: memory.totalEntries,
          memoryStaleCount: memory.staleCount,
        };
      },
    }),
  ];
}
