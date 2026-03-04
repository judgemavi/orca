import { Hono } from 'hono'
import type { ConfigStore } from '../../store/config'

export function registerConfigHandlers(app: Hono, configStore: ConfigStore) {
  app.get('/config', (c) => c.json({ data: configStore.load() }))
  app.put('/config', async (c) => {
    const patch = (await c.req.json()) as unknown
    const updated = configStore.patch(patch)
    return c.json({ data: updated })
  })
}
