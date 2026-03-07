import { z } from 'zod';
import type { ToolPluginRegistry } from '../../plugin/registry';
import { availableTools, toolModels } from '../../plugin/registry';
import type { ConfigStore } from '../../store/config';
import type { InteractionStore } from '../../store/interactions';
import type { MemoryStore } from '../../store/memory';
import type { TaskStore } from '../../store/tasks';
import { defineTool } from '../define-tool';
import type { Tool } from '../types';

const requiredTrimmedString = (field: string) =>
  z.preprocess(
    (value) => value ?? '',
    z.coerce.string().trim().min(1, `${field} is required`),
  );

const optionalTrimmedString = () =>
  z.preprocess(
    (value) => (value === undefined ? undefined : (value ?? '')),
    z.coerce.string().trim().optional(),
  );

const configGetSchema = z.object({});

const configUpdateSchema = z.object({
  patch: z
    .unknown()
    .refine(
      (value) => Boolean(value) && typeof value === 'object',
      'patch object is required',
    ),
});

const modelsListSchema = z.object({
  tool: optionalTrimmedString(),
});

const costStatusSchema = z.object({});

const qualityResultsSchema = z.object({
  taskId: requiredTrimmedString('taskId'),
});

export function adminTools(deps: {
  repoDir: string;
  configStore: ConfigStore;
  registry: ToolPluginRegistry;
  taskStore: TaskStore;
  interactions: InteractionStore;
  memory: MemoryStore;
}): Tool[] {
  return [
    defineTool({
      name: 'config_get',
      description: 'Get current Orca configuration',
      schema: configGetSchema,
      handler: async () => await deps.configStore.load(),
    }),
    defineTool({
      name: 'config_update',
      description: 'Apply a JSON patch to Orca configuration',
      schema: configUpdateSchema,
      handler: async (input) => await deps.configStore.patch(input.patch),
    }),
    defineTool({
      name: 'models_list',
      description: 'List available tools and models from tool registry',
      schema: modelsListSchema,
      handler: async (input) => {
        const tool = input.tool ?? '';
        if (tool) {
          return {
            tools: {
              [tool]: toolModels(deps.registry, tool),
            },
          };
        }

        const entries = Object.fromEntries(
          availableTools(deps.registry).map((name) => [
            name,
            toolModels(deps.registry, name),
          ]),
        );
        return { tools: entries };
      },
    }),
    defineTool({
      name: 'cost_status',
      description: 'Get project cost totals and per-tool breakdown',
      schema: costStatusSchema,
      handler: async () => ({
        totalCost: await deps.interactions.projectTotal(),
        tools: await deps.interactions.projectSummary(),
      }),
    }),
    defineTool({
      name: 'quality_results',
      description: 'Get latest run interaction quality results for a task',
      schema: qualityResultsSchema,
      handler: async (input) => {
        const taskID = input.taskId;
        const items = await deps.interactions.listByType(taskID, 'code');
        const latest = items.find((item) => item.qualityJson?.trim());
        if (!latest?.qualityJson) {
          return { taskId: taskID, quality: null };
        }
        try {
          return { taskId: taskID, quality: JSON.parse(latest.qualityJson) };
        } catch {
          return { taskId: taskID, quality: null, malformed: true };
        }
      },
    }),
  ];
}
