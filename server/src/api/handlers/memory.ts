import type { Hono } from 'hono';
import { getMemoryDetail, queryMemory } from '../../domain/memory';
import {
  getMemorySyncStatus,
  refreshMemoryEntries,
  syncMemoryWithGit,
} from '../../domain/memory-sync';
import type { MemoryStore } from '../../store/memory';
import type { MemoryCategory, MemorySourceType } from '../../types';
import { asBoolean, parseBody } from './utils';

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

interface MemoryUpdateBody {
  content?: string;
  confidence?: number;
  category?: MemoryCategory;
}

export function registerMemoryHandlers(
  app: Hono,
  repoDir: string,
  memory: MemoryStore,
) {
  app.get('/memory', async (c) => {
    const query = c.req.query() as MemoryListQuery;
    const limit = toLimit(query.limit);

    if (query.q?.trim()) {
      return c.json({ data: await queryMemory(memory, query.q.trim(), limit) });
    }

    const results = await memory.list({
      category: query.category,
      tag: query.tag,
      sourceType: query.sourceType,
      filePath: query.filePath,
      staleOnly: asBoolean(query.stale),
      coveredBefore: query.coveredBefore,
    });

    return c.json({ data: limit > 0 ? results.slice(0, limit) : results });
  });

  app.get('/memory/query', async (c) => {
    const q = c.req.query('q')?.trim() ?? '';
    if (!q) {
      return c.json({ error: 'q is required' }, 400);
    }
    const limit = toLimit(c.req.query('limit'));
    return c.json({ data: await queryMemory(memory, q, limit) });
  });

  app.get('/memory/:id', async (c) => {
    try {
      return c.json({ data: await getMemoryDetail(memory, c.req.param('id')) });
    } catch (error) {
      return c.json({ error: String((error as Error).message ?? error) }, 404);
    }
  });

  app.patch('/memory/:id', async (c) => {
    const id = c.req.param('id');
    const entry = await memory.get(id);
    if (!entry) return c.json({ error: 'memory entry not found' }, 404);

    const body = await parseBody<MemoryUpdateBody>(c.req);
    await memory.update(id, {
      content: body.content,
      confidence: body.confidence,
      category: body.category,
    });

    const updated = await memory.get(id);
    if (!updated) return c.json({ error: 'memory entry not found' }, 404);
    return c.json({ data: updated });
  });

  app.delete('/memory/:id', async (c) => {
    const id = c.req.param('id');
    await memory.delete(id);
    return c.json({ data: { deleted: id } });
  });

  app.post('/memory/sync', async (c) => {
    try {
      const result = await syncMemoryWithGit(repoDir, memory);
      return c.json({ data: result });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 500);
    }
  });

  app.post('/memory/refresh', async (c) => {
    try {
      const body = await parseBody<{ entryId?: string }>(c.req);
      const result = await refreshMemoryEntries(
        repoDir,
        memory,
        body.entryId ?? '',
      );
      return c.json({ data: result });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 500);
    }
  });

  app.get('/memory/status', async (c) => {
    try {
      const status = await getMemorySyncStatus(repoDir, memory);
      const health = await memory.buildHealthSummary();
      return c.json({
        data: {
          ...status,
          totalEntries: health.totalEntries,
          bySource: health.bySource,
          staleCount: health.staleCount,
          avgConfidence: health.avgConfidence,
        },
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
