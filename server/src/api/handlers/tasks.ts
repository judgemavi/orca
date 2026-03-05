import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import type { JobQueue } from '../../queue/queue';
import { toErrorMessage } from '../../shared/errors';
import type { InteractionStore } from '../../store/interactions';
import type { TaskStore } from '../../store/tasks';
import type { TaskStatus } from '../../types';
import { JOB_PRIORITIES } from '../../types';
import { DeleteWorkflowError, deleteTask } from '../../workflows/delete';
import { addDepsSchema, createTaskSchema, patchTaskSchema } from '../schemas';
import type { EventSink } from '../ws';
import { broadcast } from './utils';

const BLOCKED_MANUAL_STATUSES = new Set<TaskStatus>([
  'planned',
  'approved',
  'running',
  'merged',
  'review',
]);

export function taskRoutes(deps: {
  taskStore: TaskStore;
  interactionStore: InteractionStore;
  sink: EventSink;
  repoDir: string;
  queue?: JobQueue;
}) {
  const { taskStore } = deps;

  return new Hono()
    .get('/tasks', async (c) => c.json(await taskStore.list()))

    .get('/tasks/ready', async (c) => c.json(await taskStore.getReady()))

    .get('/tasks/:id', async (c) => {
      const task = await taskStore.get(c.req.param('id'));
      if (!task) return c.json({ error: 'task not found' }, 404);
      return c.json(task);
    })

    .post('/tasks', zValidator('json', createTaskSchema), async (c) => {
      const body = c.req.valid('json');
      const task = await taskStore.create({
        id: body.id,
        title: body.title,
        description: body.description ?? '',
        parentId: body.parentId ?? null,
      });
      if (deps.queue) {
        await deps.queue.enqueue({
          type: 'evaluate',
          taskId: task.id,
          priority: JOB_PRIORITIES.evaluate,
        });
      }
      return c.json(task, 201);
    })

    .patch('/tasks/:id', zValidator('json', patchTaskSchema), async (c) => {
      const taskID = c.req.param('id');
      const body = c.req.valid('json');
      const existing = await taskStore.get(taskID);
      if (!existing) {
        return c.json({ error: 'task not found' }, 404);
      }
      if (body.status !== undefined) {
        const err = validateManualStatusTransition(
          existing.status,
          body.status as TaskStatus,
        );
        if (err) {
          return c.json({ error: err }, 400);
        }
      }

      if (Array.isArray(body.dependsOn)) {
        await taskStore.updateDependencies(taskID, body.dependsOn);
      }

      await taskStore.update(taskID, {
        title: body.title,
        description: body.description,
        plan: body.plan,
        status: body.status as TaskStatus | undefined,
        sessionId: body.sessionId,
      });

      const updated = await taskStore.get(taskID);
      if (!updated) {
        return c.json({ error: 'task not found' }, 404);
      }

      return c.json(updated);
    })

    .post('/tasks/:id/deps', zValidator('json', addDepsSchema), async (c) => {
      const taskID = c.req.param('id');
      const body = c.req.valid('json');

      const existing = await taskStore.get(taskID);
      if (!existing) {
        return c.json({ error: 'task not found' }, 404);
      }

      const next = new Set(existing.dependsOn);
      if (body.dependsOn?.trim()) {
        next.add(body.dependsOn.trim());
      }
      if (Array.isArray(body.dependsOnIds)) {
        for (const dep of body.dependsOnIds) {
          const value = dep.trim();
          if (value) next.add(value);
        }
      }

      await taskStore.updateDependencies(taskID, [...next]);
      return c.json(await taskStore.get(taskID));
    })

    .delete('/tasks/:id', async (c) => {
      const taskID = c.req.param('id');

      try {
        const result = await deleteTask(taskID, {
          taskStore: deps.taskStore,
          interactions: deps.interactionStore,
          repoDir: deps.repoDir,
          queue: deps.queue,
        });

        broadcast(deps.sink, 'task.deleted', {
          id: result.taskId,
          cleanup: result.cleanup,
        });

        return c.json({
          deleted: result.taskId,
          cleanup: result.cleanup,
        });
      } catch (error) {
        if (error instanceof DeleteWorkflowError) {
          return c.json({ error: error.message }, error.status);
        }
        return c.json({ error: toErrorMessage(error) }, 500);
      }
    })

    .get('/tasks/:id/reviews', async (c) => {
      return c.json(await taskStore.listReviews(c.req.param('id')));
    });
}

function validateManualStatusTransition(
  current: TaskStatus,
  next: TaskStatus,
): string | null {
  const status = String(next).trim() as TaskStatus;
  if (!status) return 'status must be a string';
  if (status === 'pending' && current !== 'failed') {
    return 'can only move failed tasks to pending';
  }
  if (status === 'stopped' || status === 'failed' || status === 'pending') {
    return null;
  }
  if (BLOCKED_MANUAL_STATUSES.has(status)) {
    return `cannot manually set status to ${status}`;
  }
  return `cannot manually set status to ${status}`;
}
