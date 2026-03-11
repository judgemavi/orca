import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import type { OrcaDrizzleDB } from '../../db/connection';
import type { JobQueue } from '../../queue/queue';
import { createTaskSchema, updateTaskSchema } from '../../schemas/tasks';
import { toErrorMessage } from '../../shared/errors';
import type { InteractionStore } from '../../store/interactions';
import * as taskStore from '../../store/tasks';
import type { WorkflowStore } from '../../workflow/store';
import { deleteTask, isDeleteWorkflowError } from '../../workflows/delete';
import { createTask, updateTask } from '../../workflows/tasks';
import type { EventSink } from '../ws';
import { broadcast } from './utils';

export function taskRoutes(deps: {
  db: OrcaDrizzleDB;
  sink: EventSink;
  interactionStore: InteractionStore;
  repoDir: string;
  queue?: JobQueue;
  workflowStore?: WorkflowStore;
}) {
  const { db, sink } = deps;

  return new Hono()
    .get('/tasks', async (c) => c.json(await taskStore.listTasks(db)))

    .get('/tasks/ready', async (c) => c.json(await taskStore.getReadyTasks(db)))

    .get('/tasks/:id', async (c) => {
      try {
        const task = await taskStore.getTask(db, c.req.param('id'));
        return c.json(task);
      } catch (error) {
        const msg = toErrorMessage(error);
        if (msg.includes('not found')) return c.json({ error: msg }, 404);
        return c.json({ error: msg }, 500);
      }
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
          autoRunOverrides: body.autoRunOverrides,
        },
        {
          db,
          sink,
          queue: deps.queue,
          workflowStore: deps.workflowStore,
        },
      );
      return c.json(task, 201);
    })

    .patch('/tasks/:id', zValidator('json', updateTaskSchema), async (c) => {
      const taskID = c.req.param('id');
      const body = c.req.valid('json');

      try {
        const updated = await updateTask(
          {
            taskId: taskID,
            title: body.title,
            description: body.description,
            status: body.status,
            dependsOn: body.dependsOn,
            autoRunOverrides: body.autoRunOverrides,
          },
          {
            db,
            sink,
            queue: deps.queue,
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
          db,
          sink,
          interactions: deps.interactionStore,
          repoDir: deps.repoDir,
          queue: deps.queue,
        });

        broadcast(sink, 'task.deleted', {
          id: result.taskId,
          cleanup: result.cleanup,
        });

        return c.json({
          deleted: result.taskId,
          unblockedTasks: result.unblockedTasks,
          cleanup: result.cleanup,
        });
      } catch (error) {
        if (isDeleteWorkflowError(error)) {
          return c.json({ error: error.message }, error.status);
        }
        return c.json({ error: toErrorMessage(error) }, 500);
      }
    });
}
