import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import type { OrcaDrizzleDB } from '../../db/connection';
import type { EmbeddingRegistry } from '../../embedding/registry';
import type { EmbeddingConfig } from '../../embedding/types';
import { VectorStore } from '../../embedding/vector-store';
import { log } from '../../shared/logger';
import type { ConfigStore } from '../../store/config';
import type { MemoryStore } from '../../store/memory';
import { configPatchSchema } from '../schemas';
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
  configStore: ConfigStore,
  embeddingRegistry: EmbeddingRegistry,
  memoryStore: MemoryStore,
  db: OrcaDrizzleDB,
) {
  return new Hono()
    .get('/config', async (c) => c.json(await configStore.load()))
    .put('/config', zValidator('json', configPatchSchema), async (c) => {
      const patch = c.req.valid('json');
      const prevConfig = await configStore.load();
      const updated = await configStore.patch(patch);
      if (patch.orchestrator) {
        const killed = killActivePTY();
        if (killed) log.info('orchestrator config changed, killed active PTY');
      }
      if (
        patch.embeddings !== undefined &&
        embeddingConfigChanged(prevConfig.embeddings, updated.embeddings)
      ) {
        // Re-initialize embedding provider and re-embed in background
        queueMicrotask(async () => {
          try {
            if (!updated.embeddings?.provider) {
              memoryStore.setVectorStore(null as any);
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
    })
    .get('/config/embedding-providers', (c) => {
      return c.json(embeddingRegistry.providers());
    });
}
