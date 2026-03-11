import { zValidator } from '@hono/zod-validator';
import { SYSTEM_JOB_PRIORITIES } from '@orca/types';
import { Hono } from 'hono';
import type { OrcaDrizzleDB } from '../../db/connection';
import {
  listTrackedFiles,
  readExploreContext,
  writeExploreContext,
} from '../../domain/explore';
import type { JobQueue } from '../../queue/queue';
import { exploreContextSchema, exploreSchema } from '../../schemas/explore';
import * as configStore from '../../store/config';

export function exploreRoutes(
  repoDir: string,
  queue: JobQueue,
  db?: OrcaDrizzleDB,
) {
  return new Hono()
    .post('/memory/explore', zValidator('json', exploreSchema), async (c) => {
      if (db) {
        const config = await configStore.loadConfig(db);
        if (config.memory?.enabled === false) {
          return c.json({ error: 'memory is disabled' }, 400);
        }
      }

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
        priority: SYSTEM_JOB_PRIORITIES.explore,
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
