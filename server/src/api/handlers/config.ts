import type { Hono } from 'hono';
import type { ConfigStore } from '../../store/config';
import { killActivePTY } from './orchestrator';

export function registerConfigHandlers(app: Hono, configStore: ConfigStore) {
  app.get('/config', async (c) => c.json({ data: await configStore.load() }));
  app.put('/config', async (c) => {
    const patch = (await c.req.json()) as Record<string, unknown>;
    const updated = await configStore.patch(patch);
    if (patch.orchestrator) {
      const killed = killActivePTY();
      if (killed) console.log('[config] orchestrator config changed, killed active PTY');
    }
    return c.json({ data: updated });
  });
}
