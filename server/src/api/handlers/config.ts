import { Hono } from 'hono';
import type { ConfigStore } from '../../store/config';
import { killActivePTY } from './orchestrator';

export function configRoutes(configStore: ConfigStore) {
  return new Hono()
    .get('/config', async (c) => c.json(await configStore.load()))
    .put('/config', async (c) => {
      const patch = (await c.req.json()) as Record<string, unknown>;
      const updated = await configStore.patch(patch);
      if (patch.orchestrator) {
        const killed = killActivePTY();
        if (killed)
          console.log(
            '[config] orchestrator config changed, killed active PTY',
          );
      }
      return c.json(updated);
    });
}
