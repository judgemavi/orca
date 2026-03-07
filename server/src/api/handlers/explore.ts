import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import {
  listTrackedFiles,
  readExploreContext,
  writeExploreContext,
} from '../../domain/explore';
import type { JobQueue } from '../../queue/queue';
import { JOB_PRIORITIES } from '../../types';
import { exploreContextSchema, exploreSchema } from '../schemas';

export function exploreRoutes(repoDir: string, queue: JobQueue) {
  return new Hono()
    .post('/memory/explore', zValidator('json', exploreSchema), async (c) => {
      const tracked = await listTrackedFiles(repoDir);
      if (tracked.length === 0) {
        return c.json({
          status: 'skipped',
          message: 'No tracked files found to explore',
        });
      }

      const body = c.req.valid('json');

      const { id: jobId } = await queue.enqueue({
        type: 'explore',
        priority: JOB_PRIORITIES.explore,
        payload: {
          query: body.query ?? '',
          tool: body.tool ?? '',
          model: body.model ?? '',
        },
      });

      return c.json({ status: 'queued', jobId }, 202);
    })
    .get('/memory/explore/context', async (c) => {
      const content = await readExploreContext(repoDir);
      return c.json(content);
    })
    .put(
      '/memory/explore/context',
      zValidator('json', exploreContextSchema),
      async (c) => {
        const body = c.req.valid('json');
        const path = await writeExploreContext(
          repoDir,
          (body.content ?? '').trim(),
        );
        return c.json(path);
      },
    );
}
