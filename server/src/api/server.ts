import { Hono } from 'hono'
import type { EventSink } from './ws'

export function startHTTPServer(app: Hono, port: number, sink?: EventSink) {
  const sockets = new Set<any>()

  let unsubscribe = () => {}
  if (sink) {
    unsubscribe = sink.subscribe((event) => {
      const payload = JSON.stringify(event)
      for (const socket of sockets) {
        try {
          socket.send(payload)
        } catch {
          // Ignore socket send failures; close handler will clean up.
        }
      }
    })
  }

  const server = Bun.serve({
    port,
    idleTimeout: 255,
    fetch(request, serverRef) {
      const url = new URL(request.url)
      if (url.pathname === '/api/v1/ws') {
        const upgraded = serverRef.upgrade(request)
        if (upgraded) return undefined
        return new Response('WebSocket upgrade failed', { status: 400 })
      }
      return app.fetch(request)
    },
    websocket: {
      open(ws) {
        sockets.add(ws)
      },
      message() {
        // Server-side websocket is broadcast-only for now.
      },
      close(ws) {
        sockets.delete(ws)
      },
    },
  })

  server.ref()
  const originalStop = server.stop.bind(server)
  server.stop = (closeActiveConnections?: boolean) => {
    unsubscribe()
    return originalStop(closeActiveConnections)
  }

  return server
}
