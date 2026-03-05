import { z } from 'zod';
import type { ToolPluginRegistry } from '../../plugin/registry';
import type { Executor } from '../../executor/executor';
import type { ConfigStore } from '../../store/config';
import type { InteractionStore } from '../../store/interactions';
import type { TaskStore } from '../../store/tasks';
import {
  approveTask,
  requestChanges,
  runAIReviewWorkflow,
} from '../../workflows/review';
import { defineTool } from '../define-tool';
import type { Tool } from '../types';

const requiredTrimmedString = (field: string) =>
  z.preprocess(
    (value) => value ?? '',
    z.coerce.string().trim().min(1, `${field} is required`),
  );

const optionalString = () =>
  z.preprocess(
    (value) => (value === undefined ? undefined : (value ?? '')),
    z.coerce.string().optional(),
  );

const tasksApproveSchema = z.object({
  taskId: requiredTrimmedString('taskId'),
});

const tasksRequestChangesSchema = z.object({
  taskId: requiredTrimmedString('taskId'),
  feedback: requiredTrimmedString('feedback'),
  interactionId: optionalString(),
  tool: optionalString(),
  model: optionalString(),
});

const aiReviewSchema = z.object({
  taskId: requiredTrimmedString('taskId'),
  prompt: optionalString(),
  tool: optionalString(),
  model: optionalString(),
});

const tasksReviewsSchema = z.object({
  taskId: requiredTrimmedString('taskId'),
});

export function reviewTools(deps: {
  repoDir: string;
  configStore: ConfigStore;
  registry: ToolPluginRegistry;
  taskStore: TaskStore;
  executor: Executor;
  interactions: InteractionStore;
}): Tool[] {
  const tools: Tool[] = [
    defineTool({
      name: 'tasks_approve',
      description: 'Approve task in review',
      schema: tasksApproveSchema,
      handler: async (input) => {
        const updated = await approveTask(input.taskId, {
          taskStore: deps.taskStore,
        });
        return { task: updated };
      },
    }),
    defineTool({
      name: 'tasks_request_changes',
      description: 'Request changes and rerun task',
      schema: tasksRequestChangesSchema,
      handler: async (input) => {
        const result = await requestChanges(input.taskId, input.feedback, {
          taskStore: deps.taskStore,
          interactions: deps.interactions,
          executor: deps.executor,
          interactionId: input.interactionId ?? '',
          opts: {
            toolOverride: input.tool ?? '',
            modelOverride: input.model ?? '',
          },
        });
        return result;
      },
    }),
    defineTool({
      name: 'ai_review',
      description: 'Run LLM-backed AI review for task diff',
      schema: aiReviewSchema,
      handler: async (input) => {
        return await runAIReviewWorkflow(input.taskId, {
          repoDir: deps.repoDir,
          configStore: deps.configStore,
          registry: deps.registry,
          taskStore: deps.taskStore,
          interactions: deps.interactions,
          prompt: input.prompt ?? '',
          toolOverride: input.tool ?? '',
          modelOverride: input.model ?? '',
        });
      },
    }),
    defineTool({
      name: 'tasks_reviews',
      description: 'List reviews for task',
      schema: tasksReviewsSchema,
      handler: async (input) => {
        return { reviews: await deps.taskStore.listReviews(input.taskId) };
      },
    }),
  ];

  return [
    ...tools,
    alias('approve', 'tasks_approve', tools),
    alias('request_changes', 'tasks_request_changes', tools),
  ];
}

function alias(name: string, target: string, tools: Tool[]): Tool {
  const source = tools.find((tool) => tool.name === target);
  if (!source) throw new Error(`missing source tool for alias: ${target}`);
  return { ...source, name };
}
