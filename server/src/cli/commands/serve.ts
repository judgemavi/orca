import type { Hono } from 'hono'
import type { EventSink } from '../../api/ws'
import { startHTTPServer } from '../../api/server'

export async function runServe(app: Hono, port: number, sink?: EventSink) {
  const server = startHTTPServer(app, port, sink)
  console.log(`orca server listening on :${port}`)
  await new Promise<void>((resolve) => {
    const onSignal = () => {
      console.log('\n[serve] shutting down HTTP server…')
      server.stop(true)
      resolve()
    }
    process.on('SIGINT', onSignal)
    process.on('SIGTERM', onSignal)
  })
}
