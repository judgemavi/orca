import { z } from 'zod';
import type { JobQueue } from '../../queue/queue';
import type { ConfigStore } from '../../store/config';
import type { InteractionStore } from '../../store/interactions';
import type { TaskStore } from '../../store/tasks';
import { approveTask } from '../../workflows/review';
import { requestChanges, triggerReview } from '../../workflows/tasks';
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
  configStore: ConfigStore;
  taskStore: TaskStore;
  interactions: InteractionStore;
  queue: JobQueue;
}): Tool[] {
  const tools: Tool[] = [
    defineTool({
      name: 'tasks_approve',
      description: 'Approve task in review',
      schema: tasksApproveSchema,
      handler: async (input) => {
        const updated = await approveTask(input.taskId, {
          taskStore: deps.taskStore,
          queue: deps.queue,
          configStore: deps.configStore,
        });
        return { task: updated };
      },
    }),
    defineTool({
      name: 'tasks_request_changes',
      description: 'Request changes and enqueue code job',
      schema: tasksRequestChangesSchema,
      handler: async (input) => {
        const result = await requestChanges(input.taskId, input.feedback, {
          taskStore: deps.taskStore,
          interactionStore: deps.interactions,
          queue: deps.queue,
          interactionId: input.interactionId,
          tool: input.tool,
          model: input.model,
        });
        return { ...result, status: 'queued' };
      },
    }),
    defineTool({
      name: 'ai_review',
      description: 'Enqueue AI review for task diff',
      schema: aiReviewSchema,
      handler: async (input) => {
        const result = await triggerReview(
          input.taskId,
          {
            prompt: input.prompt,
            tool: input.tool,
            model: input.model,
          },
          {
            taskStore: deps.taskStore,
            interactionStore: deps.interactions,
            queue: deps.queue,
          },
        );
        return { ...result, status: 'queued' };
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

  return tools;
}
