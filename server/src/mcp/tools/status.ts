import { z } from 'zod';
import type { InteractionStore } from '../../store/interactions';
import type { MemoryStore } from '../../store/memory';
import type { TaskStore } from '../../store/tasks';
import { InteractionStatus, TaskStatus } from '../../types';
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
          pending: tasks.filter((task) => task.status === TaskStatus.pending)
            .length,
          running: tasks.filter((task) => task.status === TaskStatus.running)
            .length,
          failed: tasks.filter((task) => task.status === TaskStatus.failed)
            .length,
          merged: tasks.filter((task) => task.status === TaskStatus.merged)
            .length,
          runningOperations: (
            await deps.interactions.listByStatus(InteractionStatus.running)
          ).length,
          totalCost: await deps.interactions.projectTotal(),
          memoryTotal: memory.totalEntries,
          memoryStaleCount: memory.staleCount,
        };
      },
    }),
  ];
}
