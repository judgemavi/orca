import { z } from 'zod';
import type { ToolPluginRegistry } from '../../plugin/registry';
import type { ConfigStore } from '../../store/config';
import type { InteractionStore } from '../../store/interactions';
import type { MemoryStore } from '../../store/memory';
import type { TaskStore } from '../../store/tasks';
import { mergeTask } from '../../workflows/merge';
import { defineTool } from '../define-tool';
import type { Tool } from '../types';

const tasksMergeSchema = z.object({
  taskId: z.preprocess(
    (value) => value ?? '',
    z.coerce.string().trim().min(1, 'taskId is required'),
  ),
});

export function mergeTools(deps: {
  repoDir: string;
  taskStore: TaskStore;
  configStore: ConfigStore;
  interactions: InteractionStore;
  memory: MemoryStore;
  registry?: ToolPluginRegistry;
}): Tool[] {
  return [
    defineTool({
      name: 'tasks_merge',
      description: 'Merge one approved task into integration branch',
      schema: tasksMergeSchema,
      handler: async (input) => {
        return await mergeTask(input.taskId, {
          repoDir: deps.repoDir,
          taskStore: deps.taskStore,
          configStore: deps.configStore,
          interactions: deps.interactions,
          memoryStore: deps.memory,
          registry: deps.registry,
        });
      },
    }),
  ];
}
