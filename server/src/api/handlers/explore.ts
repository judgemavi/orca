import { Hono } from 'hono';
import {
  listTrackedFiles,
  readExploreContext,
  writeExploreContext,
} from '../../domain/explore';
import type { JobQueue } from '../../queue/queue';
import { JOB_PRIORITIES } from '../../types';
import type { EventSink } from '../ws';
import { parseBody } from './utils';

interface ContextBody {
  content?: string;
}

interface ExploreBody {
  query?: string;
  tool?: string;
  model?: string;
}

export function exploreRoutes(
  repoDir: string,
  sink: EventSink,
  queue: JobQueue,
) {
  return new Hono()
    .post('/explore', async (c) => {
      const tracked = await listTrackedFiles(repoDir);
      if (tracked.length === 0) {
        return c.json({
          status: 'skipped',
          message: 'No tracked files found to explore',
        });
      }

      const body = await parseBody<ExploreBody>(c.req);

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
    .get('/explore/context', async (c) => {
      const content = await readExploreContext(repoDir);
      return c.json(content);
    })
    .put('/explore/context', async (c) => {
      const body = await parseBody<ContextBody>(c.req);
      const path = await writeExploreContext(
        repoDir,
        (body.content ?? '').trim(),
      );
      return c.json(path);
    });
}
