import { z } from 'zod';
import type { JobQueue } from '../../queue/queue';
import type { ConfigStore } from '../../store/config';
import type { InteractionStore } from '../../store/interactions';
import type { TaskStore } from '../../store/tasks';
import type { ProposedTask } from '../../types/api';
import {
  acceptBreakdown,
  approvePlan,
  loadProposedTasksFromInteraction,
  rejectBreakdown,
} from '../../workflows/planning';
import { enqueueBreakdown, enqueueEvaluate } from '../../workflows/tasks';
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

const optionalString = () =>
  z.preprocess(
    (value) => (value === undefined ? undefined : (value ?? '')),
    z.coerce.string().optional(),
  );

const breakdownSchema = z.object({
  taskId: requiredTrimmedString('taskId'),
  tool: optionalString(),
  model: optionalString(),
});

const tasksPlanEvaluateSchema = z.object({
  taskId: requiredTrimmedString('taskId'),
});

const tasksApprovePlanSchema = z.object({
  taskId: requiredTrimmedString('taskId'),
});

const tasksPlanGetSchema = z.object({
  taskId: requiredTrimmedString('taskId'),
});

const tasksPlanSetSchema = z.object({
  taskId: requiredTrimmedString('taskId'),
  plan: z.preprocess((value) => value ?? '', z.coerce.string()),
});

const proposedTaskSchema = z.object({
  title: z.preprocess(
    (value) => value ?? '',
    z.coerce.string().trim().min(1, 'title is required'),
  ),
  description: optionalString(),
  dependsOn: z.preprocess(
    (value) => (Array.isArray(value) ? value : undefined),
    z.array(z.preprocess((item) => item ?? '', z.coerce.string())).optional(),
  ),
  dependsOnIndices: z.preprocess(
    (value) => (Array.isArray(value) ? value : undefined),
    z.array(z.number()).optional(),
  ),
  suggestedTool: optionalString(),
});

const breakdownAcceptSchema = z.object({
  interactionId: requiredTrimmedString('interactionId'),
  parentTaskId: optionalTrimmedString(),
  tasks: z.array(proposedTaskSchema).optional(),
});

const breakdownRejectSchema = z.object({
  taskId: optionalTrimmedString(),
  interactionId: requiredTrimmedString('interactionId'),
});

export function planningTools(deps: {
  taskStore: TaskStore;
  interactions: InteractionStore;
  configStore: ConfigStore;
  queue: JobQueue;
}): Tool[] {
  const tools: Tool[] = [
    defineTool({
      name: 'breakdown',
      description: 'Enqueue a breakdown job to decompose a task into subtasks',
      schema: breakdownSchema,
      handler: async (input) => {
        const result = await enqueueBreakdown(
          input.taskId,
          { tool: input.tool, model: input.model },
          { taskStore: deps.taskStore, queue: deps.queue },
        );
        return { ...result, status: 'queued' };
      },
    }),
    defineTool({
      name: 'tasks_plan_evaluate',
      description: 'Enqueue an evaluate job for a task',
      schema: tasksPlanEvaluateSchema,
      handler: async (input) => {
        const result = await enqueueEvaluate(
          input.taskId,
          {},
          { taskStore: deps.taskStore, queue: deps.queue },
        );
        return { ...result, status: 'queued' };
      },
    }),
    defineTool({
      name: 'tasks_approve_plan',
      description: 'Approve task plan and move task to planned',
      schema: tasksApprovePlanSchema,
      handler: async (input) => {
        const updated = await approvePlan(input.taskId, {
          taskStore: deps.taskStore,
          queue: deps.queue,
          configStore: deps.configStore,
        });
        return { task: updated };
      },
    }),
    defineTool({
      name: 'tasks_plan_get',
      description: 'Get task plan text',
      schema: tasksPlanGetSchema,
      handler: async (input) => {
        const plan = await deps.taskStore.getPlan(input.taskId);
        return { taskId: input.taskId, plan };
      },
    }),
    defineTool({
      name: 'tasks_plan_set',
      description: 'Set task plan text directly',
      schema: tasksPlanSetSchema,
      handler: async (input) => {
        await deps.taskStore.setPlan(input.taskId, input.plan);
        return { taskId: input.taskId, plan: input.plan };
      },
    }),
    defineTool({
      name: 'breakdown_accept',
      description: 'Accept a proposed breakdown and create subtasks from it.',
      schema: breakdownAcceptSchema,
      handler: async (input) => {
        let proposed =
          Array.isArray(input.tasks) && input.tasks.length > 0
            ? (input.tasks as ProposedTask[])
            : [];

        if (proposed.length === 0) {
          proposed = await loadProposedTasksFromInteraction(
            input.interactionId,
            { interactions: deps.interactions },
          );
        }

        if (proposed.length === 0) {
          throw new Error(
            'No proposed tasks found for interaction ' + input.interactionId,
          );
        }
        const accepted = await acceptBreakdown(
          input.parentTaskId ?? null,
          proposed,
          { taskStore: deps.taskStore, queue: deps.queue },
        );
        return {
          created: true,
          taskIds: accepted.createdIds,
          parentId: accepted.parentId,
          interactionId: input.interactionId,
        };
      },
    }),
    defineTool({
      name: 'breakdown_reject',
      description: 'Reject a breakdown (discard proposed subtasks)',
      schema: breakdownRejectSchema,
      handler: async (input) => {
        await rejectBreakdown(input.taskId ?? '', input.interactionId, {
          interactions: deps.interactions,
        });
        return { rejected: true, interactionId: input.interactionId };
      },
    }),
  ];

  return tools;
}
