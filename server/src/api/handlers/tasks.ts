import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import type { JobQueue } from '../../queue/queue';
import { toErrorMessage } from '../../shared/errors';
import type { ConfigStore } from '../../store/config';
import type { InteractionStore } from '../../store/interactions';
import type { TaskStore } from '../../store/tasks';
import type { AutoRunOverrides } from '../../types';
import { DeleteWorkflowError, deleteTask } from '../../workflows/delete';
import { createTask, updateTask } from '../../workflows/tasks';
import { createTaskSchema, patchTaskSchema } from '../schemas';
import type { EventSink } from '../ws';
import { broadcast } from './utils';

export function taskRoutes(deps: {
  taskStore: TaskStore;
  interactionStore: InteractionStore;
  configStore: ConfigStore;
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
      const task = await createTask(
        {
          id: body.id ?? undefined,
          title: body.title,
          description: body.description ?? '',
          parentId: body.parentId ?? null,
          dependsOn: body.dependsOn,
          autoRunOverrides: body.autoRunOverrides as AutoRunOverrides,
        },
        {
          taskStore: deps.taskStore,
          queue: deps.queue,
        },
      );
      return c.json(task, 201);
    })

    .patch('/tasks/:id', zValidator('json', patchTaskSchema), async (c) => {
      const taskID = c.req.param('id');
      const body = c.req.valid('json');

      try {
        const updated = await updateTask(
          {
            taskId: taskID,
            title: body.title,
            description: body.description,
            plan: body.plan ?? undefined,
            status: body.status,
            sessionId: body.sessionId ?? undefined,
            dependsOn: body.dependsOn,
            autoRunOverrides: body.autoRunOverrides as
              | AutoRunOverrides
              | undefined,
          },
          {
            taskStore: deps.taskStore,
            queue: deps.queue,
            configStore: deps.configStore,
          },
        );
        return c.json(updated);
      } catch (error) {
        const msg = toErrorMessage(error);
        if (msg.includes('not found')) return c.json({ error: msg }, 404);
        return c.json({ error: msg }, 400);
      }
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
