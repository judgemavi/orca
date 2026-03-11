import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import type { OrcaDrizzleDB } from '../../db/connection';
import type { EmbeddingRegistry } from '../../embedding/registry';
import type { EmbeddingConfig } from '../../embedding/types';
import { VectorStore } from '../../embedding/vector-store';
import { configPatchSchema } from '../../schemas/config';
import { log } from '../../shared/logger';
import * as configStore from '../../store/config';
import type { MemoryStore } from '../../store/memory';
import type { EventSink } from '../ws';
import { killActivePTY } from './orchestrator';

function embeddingConfigChanged(
  prev: EmbeddingConfig | undefined,
  next: EmbeddingConfig | undefined,
): boolean {
  if (!prev && !next) return false;
  if (!prev || !next) return true;
  return (
    prev.provider !== next.provider ||
    prev.model !== next.model ||
    prev.documentPrefix !== next.documentPrefix ||
    prev.queryPrefix !== next.queryPrefix
  );
}

export function configRoutes(
  db: OrcaDrizzleDB,
  embeddingRegistry: EmbeddingRegistry,
  memoryStore: MemoryStore,
  sink?: EventSink,
) {
  return new Hono()
    .get('/config', async (c) => c.json(await configStore.loadConfig(db)))
    .get('/config/embedding-providers', async (c) => {
      return c.json(embeddingRegistry.providers());
    })
    .patch('/config', zValidator('json', configPatchSchema), async (c) => {
      const patch = c.req.valid('json');
      const prevConfig = await configStore.loadConfig(db);
      await configStore.patchConfig(db, sink, patch);
      const updated = await configStore.loadConfig(db);
      if (patch.orchestrator) {
        const killed = killActivePTY();
        if (killed) log.info('orchestrator config changed, killed active PTY');
      }
      if (
        patch.embeddings !== undefined &&
        embeddingConfigChanged(prevConfig.embeddings, updated.embeddings)
      ) {
        queueMicrotask(async () => {
          try {
            if (!updated.embeddings?.provider) {
              memoryStore.setVectorStore(null);
              log.info('embeddings disabled');
              return;
            }
            const plugin = await embeddingRegistry.resolve(updated.embeddings);
            if (plugin) {
              const vs = new VectorStore(db, plugin);
              memoryStore.setVectorStore(vs);
              const count = await memoryStore.reembedAll();
              log.info('embedding config changed, re-embedded', { count });
            }
          } catch (err) {
            log.warn('re-embed after config change failed', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        });
      }
      return c.json(updated);
    });
}
