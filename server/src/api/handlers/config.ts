import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { configPatchSchema } from '../schemas';
import type { ConfigStore } from '../../store/config';
import { killActivePTY } from './orchestrator';

export function configRoutes(configStore: ConfigStore) {
  return new Hono()
    .get('/config', async (c) => c.json(await configStore.load()))
    .put('/config', zValidator('json', configPatchSchema), async (c) => {
      const patch = c.req.valid('json');
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
