import { Hono } from 'hono';
import { getMemoryDetail, queryMemory } from '../../domain/memory';
import {
  getMemorySyncStatus,
  refreshMemoryEntries,
  syncMemoryWithGit,
} from '../../domain/memory-sync';
import type { MemoryStore } from '../../store/memory';
import type { MemoryCategory, MemorySourceType } from '../../types';
import { zValidator } from '@hono/zod-validator';
import { memoryRefreshSchema, memoryUpdateSchema } from '../schemas';
import { asBoolean } from './utils';

interface MemoryListQuery {
  category?: MemoryCategory;
  tag?: string;
  sourceType?: MemorySourceType;
  filePath?: string;
  stale?: string;
  coveredBefore?: string;
  q?: string;
  limit?: string;
}

export function memoryRoutes(repoDir: string, memory: MemoryStore) {
  return new Hono()
    .get('/memory', async (c) => {
      const query = c.req.query() as MemoryListQuery;
      const limit = toLimit(query.limit);

      if (query.q?.trim()) {
        return c.json(await queryMemory(memory, query.q.trim(), limit));
      }

      const results = await memory.list({
        category: query.category,
        tag: query.tag,
        sourceType: query.sourceType,
        filePath: query.filePath,
        staleOnly: asBoolean(query.stale),
        coveredBefore: query.coveredBefore,
      });

      return c.json(limit > 0 ? results.slice(0, limit) : results);
    })
    .get('/memory/query', async (c) => {
      const q = c.req.query('q')?.trim() ?? '';
      if (!q) {
        return c.json({ error: 'q is required' }, 400);
      }
      const limit = toLimit(c.req.query('limit'));
      return c.json(await queryMemory(memory, q, limit));
    })
    .get('/memory/:id', async (c) => {
      try {
        return c.json(await getMemoryDetail(memory, c.req.param('id')));
      } catch (error) {
        return c.json(
          { error: String((error as Error).message ?? error) },
          404,
        );
      }
    })
    .patch('/memory/:id', zValidator('json', memoryUpdateSchema), async (c) => {
      const id = c.req.param('id');
      const entry = await memory.get(id);
      if (!entry) return c.json({ error: 'memory entry not found' }, 404);

      const body = c.req.valid('json');
      await memory.update(id, {
        content: body.content,
        confidence: body.confidence,
        category: body.category as MemoryCategory | undefined,
      });

      const updated = await memory.get(id);
      if (!updated) return c.json({ error: 'memory entry not found' }, 404);
      return c.json(updated);
    })
    .delete('/memory/:id', async (c) => {
      const id = c.req.param('id');
      await memory.delete(id);
      return c.json({ deleted: id });
    })
    .post('/memory/sync', async (c) => {
      try {
        const result = await syncMemoryWithGit(repoDir, memory);
        return c.json(result);
      } catch (error) {
        return c.json({ error: (error as Error).message }, 500);
      }
    })
    .post('/memory/refresh', zValidator('json', memoryRefreshSchema), async (c) => {
      try {
        const body = c.req.valid('json');
        const result = await refreshMemoryEntries(
          repoDir,
          memory,
          body.entryId ?? '',
        );
        return c.json(result);
      } catch (error) {
        return c.json({ error: (error as Error).message }, 500);
      }
    })
    .get('/memory/status', async (c) => {
      try {
        const status = await getMemorySyncStatus(repoDir, memory);
        const health = await memory.buildHealthSummary();
        return c.json({
          ...status,
          totalEntries: health.totalEntries,
          bySource: health.bySource,
          staleCount: health.staleCount,
          avgConfidence: health.avgConfidence,
        });
      } catch (error) {
        return c.json({ error: (error as Error).message }, 500);
      }
    });
}

function toLimit(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 50;
  return Math.min(parsed, 500);
}
