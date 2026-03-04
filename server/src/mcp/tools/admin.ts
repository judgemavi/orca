import { z } from 'zod';
import { getMemorySyncStatus } from '../../domain/memory-sync';
import type { DriverRegistry } from '../../driver/registry';
import { availableTools, toolModels } from '../../driver/registry';
import type { ConfigStore } from '../../store/config';
import type { InteractionStore } from '../../store/interactions';
import type { MemoryStore } from '../../store/memory';
import type { TaskStore } from '../../store/tasks';
import { InteractionStatus, Phase, TaskStatus } from '../../types';
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

const projectStatusSchema = z.object({});

const costStatusSchema = z.object({});

const qualityResultsSchema = z.object({
  taskId: requiredTrimmedString('taskId'),
});

export function adminTools(deps: {
  repoDir: string;
  configStore: ConfigStore;
  registry: DriverRegistry;
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
      name: 'project_status',
      description: 'Get project status summary',
      schema: projectStatusSchema,
      handler: async () => {
        const tasks = await deps.taskStore.list();
        const memoryHealth = await deps.memory.buildHealthSummary();
        const sync = await getMemorySyncStatus(deps.repoDir, deps.memory);

        return {
          project: 'orca',
          totalTasks: tasks.length,
          pending: tasks.filter((task) => task.status === TaskStatus.pending)
            .length,
          inProgress: tasks.filter((task) => task.status === TaskStatus.running)
            .length,
          completed: tasks.filter(
            (task) =>
              task.status === TaskStatus.merged ||
              task.status === TaskStatus.approved ||
              task.status === TaskStatus.review ||
              task.status === TaskStatus.broken_down,
          ).length,
          failed: tasks.filter((task) => task.status === TaskStatus.failed)
            .length,
          totalCost: await deps.interactions.projectTotal(),
          runningOperations: (
            await deps.interactions.listByStatus(InteractionStatus.running)
          ).length,
          lastSyncedCommit: sync.lastSyncedCommit,
          currentCommit: sync.currentCommit,
          syncNeeded: sync.syncNeeded,
          commitsBehind: sync.commitsBehind,
          memoryTotal: memoryHealth.totalEntries,
          memoryStaleCount: memoryHealth.staleCount,
        };
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
      description: 'Get latest run-phase quality results for a task',
      schema: qualityResultsSchema,
      handler: async (input) => {
        const taskID = input.taskId;
        const items = await deps.interactions.listByPhase(taskID, Phase.run);
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
