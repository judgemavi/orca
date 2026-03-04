import type { Hono } from 'hono';
import type { JobQueue } from '../../queue/queue';
import type { JobStatus } from '../../types';

export function registerQueueHandlers(app: Hono, deps: { queue: JobQueue }) {
  const { queue } = deps;

  app.get('/queue/counts', async (c) => {
    const counts = await queue.counts();
    return c.json({ data: counts });
  });

  app.get('/queue', async (c) => {
    const status = (c.req.query('status') ?? '').trim() as JobStatus | '';
    const taskId = (c.req.query('taskId') ?? '').trim();
    const limitRaw = c.req.query('limit');
    const limit = limitRaw ? Math.min(Number(limitRaw) || 100, 500) : 100;

    const jobs = await queue.list({
      status: status || undefined,
      taskId: taskId || undefined,
      limit,
    });

    return c.json({ data: jobs });
  });

  app.get('/queue/:id', async (c) => {
    const job = await queue.get(c.req.param('id'));
    if (!job) return c.json({ error: 'job not found' }, 404);
    return c.json({ data: job });
  });

  app.delete('/queue/:id', async (c) => {
    const jobId = c.req.param('id');
    const job = await queue.get(jobId);
    if (!job) return c.json({ error: 'job not found' }, 404);
    if (job.status !== 'queued') {
      return c.json(
        { error: `cannot cancel job in status: ${job.status}` },
        400,
      );
    }
    const cancelled = await queue.cancel(jobId);
    return c.json({ data: { cancelled } });
  });

  app.delete('/queue', async (c) => {
    const cancelled = await queue.drain();
    return c.json({ data: { cancelled } });
  });
}
