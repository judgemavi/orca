import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import type { JobQueue } from '../../queue/queue';
import type { TaskStore } from '../../store/tasks';
import { JOB_PRIORITIES } from '../../types';
import { mergeBodySchema } from '../schemas';

export function mergeRoutes(deps: { taskStore: TaskStore; queue: JobQueue }) {
  return new Hono().post(
    '/tasks/:id/merge',
    zValidator('json', mergeBodySchema),
    async (c) => {
      const taskID = c.req.param('id');
      const task = await deps.taskStore.get(taskID);
      if (!task) return c.json({ error: 'task not found' }, 404);

      const { id: jobId } = await deps.queue.enqueue({
        type: 'merge',
        taskId: taskID,
        priority: JOB_PRIORITIES.merge,
      });

      return c.json({ jobId, taskId: taskID, status: 'queued' }, 202);
    },
  );
}
