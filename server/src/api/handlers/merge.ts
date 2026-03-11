import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import type { OrcaDrizzleDB } from '../../db/connection';
import type { JobQueue } from '../../queue/queue';
import { mergeBodySchema } from '../../schemas/merge';
import { enqueueCurrentStep } from '../../workflows/tasks';
import type { EventSink } from '../ws';

export function mergeRoutes(deps: {
  db: OrcaDrizzleDB;
  sink?: EventSink;
  queue: JobQueue;
}) {
  return new Hono().post(
    '/tasks/:id/merge',
    zValidator('json', mergeBodySchema),
    async (c) => {
      const taskID = c.req.param('id');
      try {
        const result = await enqueueCurrentStep(taskID, undefined, {
          db: deps.db,
          sink: deps.sink,
          queue: deps.queue,
        });
        return c.json({ ...result, status: 'queued' }, 202);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.startsWith('task not found:')) {
          return c.json({ error: 'task not found' }, 404);
        }
        return c.json({ error: message }, 400);
      }
    },
  );
}
