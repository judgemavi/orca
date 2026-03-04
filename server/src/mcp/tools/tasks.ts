import { z } from 'zod';
import type { EventSink } from '../../api/ws';
import type { Executor } from '../../executor/executor';
import type { JobQueue } from '../../queue/queue';
import type { InteractionStore } from '../../store/interactions';
import type { TaskStore } from '../../store/tasks';
import type { TaskStatus } from '../../types';
import { JOB_PRIORITIES } from '../../types';
import { deleteTask } from '../../workflows/delete';
import { resumeTask, startTasks, stopTask } from '../../workflows/run';
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
});

const tasksUpdateSchema = z.object({
  taskId: requiredTrimmedString('taskId'),
  title: optionalString(),
  description: optionalString(),
  plan: optionalString(),
  status: optionalTrimmedString(),
  sessionId: optionalString(),
});

const tasksDeleteSchema = z.object({
  taskId: requiredTrimmedString('taskId'),
});

const tasksAddDependencySchema = z.object({
  taskId: requiredTrimmedString('taskId'),
  dependsOn: requiredTrimmedString('dependsOn'),
});

const tasksStartSchema = z.object({
  taskIds: z.preprocess(
    (value) => (Array.isArray(value) ? value : undefined),
    z.array(z.preprocess((item) => item ?? '', z.coerce.string())).optional(),
  ),
  tool: optionalString(),
  model: optionalString(),
  context: optionalString(),
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
  executor: Executor;
  sink?: EventSink;
  queue?: JobQueue;
}): Tool[] {
  const tools: Tool[] = [
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
        const task = await deps.taskStore.create({
          title: input.title,
          description: input.description ?? '',
          parentId: input.parentId ?? null,
        });

        if (Array.isArray(input.dependsOn) && input.dependsOn.length > 0) {
          await deps.taskStore.updateDependencies(
            task.id,
            input.dependsOn.map((value) => value.trim()).filter(Boolean),
          );
        }

        if (deps.queue) {
          await deps.queue.enqueue({
            type: 'evaluate',
            taskId: task.id,
            priority: JOB_PRIORITIES.evaluate,
          });
        }

        return { task: await deps.taskStore.get(task.id) };
      },
    }),
    defineTool({
      name: 'tasks_update',
      description: 'Update task fields',
      schema: tasksUpdateSchema,
      handler: async (input) => {
        const taskID = input.taskId;
        const existing = await deps.taskStore.get(taskID);
        if (!existing) throw new Error(`task not found: ${taskID}`);
        if (input.status !== undefined) {
          const error = validateManualStatusTransition(
            existing.status,
            input.status,
          );
          if (error) throw new Error(error);
        }

        await deps.taskStore.update(taskID, {
          title: input.title,
          description: input.description,
          plan: input.plan,
          status: input.status as TaskStatus,
          sessionId: input.sessionId ?? null,
        });
        const task = await deps.taskStore.get(taskID);
        if (!task) throw new Error(`task not found: ${taskID}`);
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
      name: 'tasks_add_dependency',
      description: 'Add task dependency',
      schema: tasksAddDependencySchema,
      handler: async (input) => {
        const taskID = input.taskId;
        const dependsOn = input.dependsOn;
        await deps.taskStore.addDependency(taskID, dependsOn);
        return { taskId: taskID, dependsOn: dependsOn };
      },
    }),
    defineTool({
      name: 'tasks_start',
      description: 'Start one or more tasks',
      schema: tasksStartSchema,
      handler: async (input) => {
        const taskIDs = Array.isArray(input.taskIds)
          ? input.taskIds.map((id) => id.trim()).filter(Boolean)
          : [];
        const runOpts = {
          taskIds: taskIDs,
          toolOverride: input.tool ?? '',
          modelOverride: input.model ?? '',
          context: input.context ?? '',
        };

        if (taskIDs.length > 0) {
          const results = await startTasks(deps.executor, runOpts);
          return { taskIds: taskIDs, results };
        }

        const results = await startTasks(deps.executor, runOpts);
        return { results };
      },
    }),
    defineTool({
      name: 'tasks_stop',
      description: 'Stop a running task',
      schema: tasksStopSchema,
      handler: async (input) => {
        const taskID = input.taskId;
        await stopTask(deps.executor, deps.taskStore, taskID);
        return { taskId: taskID, status: 'stopped' };
      },
    }),
    defineTool({
      name: 'tasks_resume',
      description: 'Resume stopped task',
      schema: tasksResumeSchema,
      handler: async (input) => {
        const taskID = input.taskId;
        const result = await resumeTask(
          deps.executor,
          deps.taskStore,
          taskID,
          input.feedback ?? '',
          {
            toolOverride: input.tool ?? '',
            modelOverride: input.model ?? '',
          },
        );
        return { taskId: taskID, status: result.status, result };
      },
    }),
  ];

  // Backward-compatible aliases.
  return [
    ...tools,
    alias('task_get', 'tasks_get', tools),
    alias('task_create', 'tasks_create', tools),
    alias('task_update_status', 'tasks_update', tools),
    alias('task_run', 'tasks_start', tools),
    alias('task_stop', 'tasks_stop', tools),
    alias('task_resume', 'tasks_resume', tools),
  ];
}

const BLOCKED_MANUAL_STATUSES = new Set<TaskStatus>([
  'planned',
  'approved',
  'running',
  'merged',
  'review',
]);

function validateManualStatusTransition(
  current: TaskStatus,
  nextRaw: string,
): string | null {
  const next = nextRaw.trim() as TaskStatus;
  if (!next) return 'status must be a string';
  if (next === 'pending' && current !== 'failed') {
    return 'can only move failed tasks to pending';
  }
  if (next === 'stopped' || next === 'failed' || next === 'pending') {
    return null;
  }
  if (BLOCKED_MANUAL_STATUSES.has(next)) {
    return `cannot manually set status to ${next}`;
  }
  return `cannot manually set status to ${next}`;
}

function alias(name: string, target: string, tools: Tool[]): Tool {
  const source = tools.find((tool) => tool.name === target);
  if (!source) {
    throw new Error(`missing source tool for alias: ${target}`);
  }
  return {
    ...source,
    name,
  };
}
