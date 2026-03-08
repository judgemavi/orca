import { z } from 'zod';
import type { JobQueue } from '../../queue/queue';
import type { ConfigStore } from '../../store/config';
import type { InteractionStore } from '../../store/interactions';
import type { TaskStore } from '../../store/tasks';
import type { TaskStatus } from '../../types';
import { deleteTask } from '../../workflows/delete';
import {
  createTask,
  enqueueEvaluate,
  provideInput,
  resumeTask,
  stopTask,
  updateTask,
} from '../../workflows/tasks';
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

const tasksListSchema = z.object({
  status: optionalTrimmedString(),
});

const tasksGetSchema = z.object({
  taskId: requiredTrimmedString('taskId'),
});

const tasksCreateSchema = z.object({
  title: requiredTrimmedString('title'),
  description: optionalString(),
  parentId: z.preprocess(
    (value) => (value === undefined ? undefined : value),
    z.union([z.coerce.string(), z.null()]).optional(),
  ),
  dependsOn: z.preprocess(
    (value) => (Array.isArray(value) ? value : undefined),
    z.array(z.preprocess((item) => item ?? '', z.coerce.string())).optional(),
  ),
  autoRunOverrides: z.record(z.string(), z.boolean()).optional(),
});

const tasksUpdateSchema = z.object({
  taskId: requiredTrimmedString('taskId'),
  title: optionalString(),
  description: optionalString(),
  plan: optionalString(),
  status: optionalTrimmedString(),
  sessionId: optionalString(),
  dependsOn: z.preprocess(
    (value) => (Array.isArray(value) ? value : undefined),
    z.array(z.preprocess((item) => item ?? '', z.coerce.string())).optional(),
  ),
  autoRunOverrides: z.record(z.string(), z.boolean()).optional(),
});

const tasksDeleteSchema = z.object({
  taskId: requiredTrimmedString('taskId'),
});

const tasksStartSchema = z.object({
  taskIds: z.preprocess(
    (value) => (Array.isArray(value) ? value : undefined),
    z.array(z.preprocess((item) => item ?? '', z.coerce.string())).optional(),
  ),
  tool: optionalString(),
  model: optionalString(),
});

const tasksReadySchema = z.object({});

const tasksProvideInputSchema = z.object({
  taskId: requiredTrimmedString('taskId'),
  answer: z.preprocess(
    (value) => value ?? '',
    z.coerce.string().trim().min(1, 'answer is required'),
  ),
});

const tasksStopSchema = z.object({
  taskId: requiredTrimmedString('taskId'),
});

const tasksResumeSchema = z.object({
  taskId: requiredTrimmedString('taskId'),
  feedback: optionalString(),
  tool: optionalString(),
  model: optionalString(),
});

export function taskTools(deps: {
  repoDir: string;
  taskStore: TaskStore;
  interactions: InteractionStore;
  configStore?: ConfigStore;
  queue: JobQueue;
}): Tool[] {
  const tools: Tool[] = [
    defineTool({
      name: 'tasks_ready',
      description:
        'List tasks ready to start (pending with all dependencies merged)',
      schema: tasksReadySchema,
      handler: async () => {
        return { tasks: await deps.taskStore.getReady() };
      },
    }),
    defineTool({
      name: 'tasks_list',
      description: 'List tasks (optionally by status)',
      schema: tasksListSchema,
      handler: async (input) => {
        const status = input.status ?? '';
        if (!status) return { tasks: await deps.taskStore.list() };
        return {
          tasks: await deps.taskStore.listByStatus(status as TaskStatus),
        };
      },
    }),
    defineTool({
      name: 'tasks_get',
      description: 'Get task by id',
      schema: tasksGetSchema,
      handler: async (input) => {
        const taskID = input.taskId;
        const task = await deps.taskStore.get(taskID);
        if (!task) throw new Error(`task not found: ${taskID}`);
        return { task };
      },
    }),
    defineTool({
      name: 'tasks_create',
      description: 'Create a new task',
      schema: tasksCreateSchema,
      handler: async (input) => {
        const task = await createTask(
          {
            title: input.title,
            description: input.description ?? '',
            parentId: input.parentId ?? null,
            dependsOn: input.dependsOn,
            autoRunOverrides: input.autoRunOverrides,
          },
          {
            taskStore: deps.taskStore,
            queue: deps.queue,
          },
        );
        return { task };
      },
    }),
    defineTool({
      name: 'tasks_update',
      description: 'Update task fields',
      schema: tasksUpdateSchema,
      handler: async (input) => {
        const task = await updateTask(
          {
            taskId: input.taskId,
            title: input.title,
            description: input.description,
            plan: input.plan,
            status: input.status,
            sessionId: input.sessionId ?? null,
            dependsOn: input.dependsOn,
            autoRunOverrides: input.autoRunOverrides,
          },
          {
            taskStore: deps.taskStore,
            queue: deps.queue,
            configStore: deps.configStore,
          },
        );
        return { task };
      },
    }),
    defineTool({
      name: 'tasks_delete',
      description: 'Delete a task',
      schema: tasksDeleteSchema,
      handler: async (input) => {
        const taskID = input.taskId;
        return await deleteTask(taskID, {
          repoDir: deps.repoDir,
          taskStore: deps.taskStore,
          interactions: deps.interactions,
        });
      },
    }),
    defineTool({
      name: 'tasks_start',
      description: 'Start one or more tasks by enqueuing evaluate jobs',
      schema: tasksStartSchema,
      handler: async (input) => {
        const taskIDs = Array.isArray(input.taskIds)
          ? input.taskIds.map((id) => id.trim()).filter(Boolean)
          : [];

        const results = [];
        for (const taskId of taskIDs) {
          const result = await enqueueEvaluate(
            taskId,
            { tool: input.tool, model: input.model },
            { taskStore: deps.taskStore, queue: deps.queue },
          );
          results.push(result);
        }
        return { taskIds: taskIDs, results };
      },
    }),
    defineTool({
      name: 'tasks_stop',
      description: 'Stop a running task',
      schema: tasksStopSchema,
      handler: async (input) => {
        return await stopTask(input.taskId, {
          taskStore: deps.taskStore,
          queue: deps.queue,
        });
      },
    }),
    defineTool({
      name: 'tasks_resume',
      description: 'Resume stopped task by enqueuing code job with feedback',
      schema: tasksResumeSchema,
      handler: async (input) => {
        const result = await resumeTask(
          input.taskId,
          input.feedback ?? '',
          { tool: input.tool, model: input.model },
          { taskStore: deps.taskStore, queue: deps.queue },
        );
        return { ...result, status: 'queued' };
      },
    }),
    defineTool({
      name: 'tasks_provide_input',
      description:
        'Answer a pending question for a stopped task. The answer is appended to the task description and evaluate re-runs.',
      schema: tasksProvideInputSchema,
      handler: async (input) => {
        const result = await provideInput(input.taskId, input.answer, {
          taskStore: deps.taskStore,
          queue: deps.queue,
        });
        return { taskId: result.taskId, status: 'queued' };
      },
    }),
  ];

  return tools;
}
