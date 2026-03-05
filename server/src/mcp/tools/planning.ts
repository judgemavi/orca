import { z } from 'zod';
import type { ToolPluginRegistry } from '../../plugin/registry';
import type { ConfigStore } from '../../store/config';
import type { InteractionStore } from '../../store/interactions';
import type { MemoryStore } from '../../store/memory';
import type { TaskStore } from '../../store/tasks';
import {
  acceptBreakdown,
  approvePlan,
  breakdownTask,
  evaluateTaskWorkflow,
  generatePlan,
  rejectBreakdown,
  requestPlanChanges,
} from '../../workflows/planning';
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

const breakdownSchema = z
  .object({
    goal: optionalTrimmedString(),
    taskId: optionalTrimmedString(),
    autoCreate: z.boolean().optional().catch(undefined),
    tool: optionalString(),
    model: optionalString(),
  })
  .superRefine((input, ctx) => {
    if (!(input.taskId ?? '') && !(input.goal ?? '')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'goal or taskId is required',
        path: ['goal'],
      });
    }
  });

const tasksPlanGenerateSchema = z.object({
  taskId: requiredTrimmedString('taskId'),
  save: z.boolean().optional().catch(undefined),
});

const tasksPlanEvaluateSchema = z.object({
  taskId: requiredTrimmedString('taskId'),
});

const tasksApprovePlanSchema = z.object({
  taskId: requiredTrimmedString('taskId'),
});

const tasksRequestPlanChangesSchema = z.object({
  taskId: requiredTrimmedString('taskId'),
  feedback: requiredTrimmedString('feedback'),
  interactionId: optionalString(),
});

const tasksPlanGetSchema = z.object({
  taskId: requiredTrimmedString('taskId'),
});

const tasksPlanSetSchema = z.object({
  taskId: requiredTrimmedString('taskId'),
  plan: z.preprocess(
    (value) => value ?? '',
    z.coerce.string(),
  ),
});

const breakdownRejectSchema = z.object({
  taskId: optionalTrimmedString(),
  interactionId: requiredTrimmedString('interactionId'),
});

export function planningTools(deps: {
  repoDir: string;
  configStore: ConfigStore;
  registry: ToolPluginRegistry;
  taskStore: TaskStore;
  interactions: InteractionStore;
  memory: MemoryStore;
}): Tool[] {
  const tools: Tool[] = [
    defineTool({
      name: 'breakdown',
      description: 'Break down a goal or task into subtasks',
      schema: breakdownSchema,
      handler: async (input) => {
        const breakdown = await breakdownTask(
          {
            goal: input.goal ?? '',
            taskId: input.taskId ?? '',
            toolOverride: input.tool ?? '',
            modelOverride: input.model ?? '',
          },
          {
            repoDir: deps.repoDir,
            taskStore: deps.taskStore,
            interactions: deps.interactions,
            configStore: deps.configStore,
            registry: deps.registry,
            memory: deps.memory,
          },
        );
        const proposed = breakdown.proposed;
        const autoCreate = input.autoCreate === true;
        if (!autoCreate) {
          return {
            proposedTasks: proposed,
            created: false,
            interactionId: breakdown.interactionId,
            tool: breakdown.tool,
            model: breakdown.model,
          };
        }

        const accepted = await acceptBreakdown(
          breakdown.taskId ?? null,
          proposed,
          {
            taskStore: deps.taskStore,
          },
        );
        return {
          created: true,
          taskIds: accepted.createdIds,
          parentId: accepted.parentId,
          interactionId: breakdown.interactionId,
          tool: breakdown.tool,
          model: breakdown.model,
        };
      },
    }),
    defineTool({
      name: 'tasks_plan_generate',
      description: 'Generate task execution plan',
      schema: tasksPlanGenerateSchema,
      handler: async (input) => {
        const taskID = input.taskId;
        const result = await generatePlan(taskID, {
          repoDir: deps.repoDir,
          taskStore: deps.taskStore,
          interactions: deps.interactions,
          configStore: deps.configStore,
          registry: deps.registry,
          memory: deps.memory,
        });
        const save = input.save !== false;
        if (save) {
          await deps.taskStore.setPlan(taskID, result.plan);
        }
        return {
          taskId: taskID,
          plan: result.plan,
          saved: save,
          memory: result.memory,
          interactionId: result.interactionId,
        };
      },
    }),
    defineTool({
      name: 'tasks_plan_evaluate',
      description: 'Evaluate plan complexity and breakdown need',
      schema: tasksPlanEvaluateSchema,
      handler: async (input) => {
        const evaluation = await evaluateTaskWorkflow(input.taskId, {
          repoDir: deps.repoDir,
          taskStore: deps.taskStore,
          interactions: deps.interactions,
          configStore: deps.configStore,
          registry: deps.registry,
        });
        return {
          taskId: input.taskId,
          evaluation,
        };
      },
    }),
    defineTool({
      name: 'tasks_approve_plan',
      description: 'Approve task plan and move task to planned',
      schema: tasksApprovePlanSchema,
      handler: async (input) => {
        const updated = await approvePlan(input.taskId, {
          taskStore: deps.taskStore,
        });
        return { task: updated };
      },
    }),
    defineTool({
      name: 'tasks_request_plan_changes',
      description: 'Request plan changes and regenerate plan from feedback',
      schema: tasksRequestPlanChangesSchema,
      handler: async (input) => {
        const taskID = input.taskId;
        const result = await requestPlanChanges(taskID, input.feedback, {
          repoDir: deps.repoDir,
          taskStore: deps.taskStore,
          interactions: deps.interactions,
          configStore: deps.configStore,
          registry: deps.registry,
          memory: deps.memory,
          interactionId: input.interactionId ?? '',
        });
        return {
          taskId: taskID,
          plan: result.plan,
          reviewId: result.reviewId,
          interactionId: result.interactionId,
        };
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

  return [
    ...tools,
    alias('plan_generate', 'tasks_plan_generate', tools),
    alias('plan_evaluate', 'tasks_plan_evaluate', tools),
    alias('approve_plan', 'tasks_approve_plan', tools),
    alias('request_plan_changes', 'tasks_request_plan_changes', tools),
  ];
}

function alias(name: string, target: string, tools: Tool[]): Tool {
  const source = tools.find((tool) => tool.name === target);
  if (!source) throw new Error(`missing source tool for alias: ${target}`);
  return { ...source, name };
}
