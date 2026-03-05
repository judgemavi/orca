import type { Hono } from 'hono';
import type { DriverRegistry } from '../driver/registry';
import type { ConfigStore } from '../store/config';
import {
  handleOrchestratorUpgrade,
  onOrchestratorWSClose,
  onOrchestratorWSMessage,
  onOrchestratorWSOpen,
} from './handlers/orchestrator';
import type { EventSink } from './ws';

export function startHTTPServer(
  app: Hono,
  port: number,
  sink?: EventSink,
  opts?: {
    configStore: ConfigStore;
    repoDir: string;
    registry: DriverRegistry;
  },
) {
  const broadcastSockets = new Set<any>();
  const orchestratorSockets = new Set<any>();

  let unsubscribe = () => {};
  if (sink) {
    unsubscribe = sink.subscribe((event) => {
      const payload = JSON.stringify(event);
      for (const socket of broadcastSockets) {
        try {
          socket.send(payload);
        } catch {}
      }
    });
  }

  const server = Bun.serve({
    port,
    idleTimeout: 255,
    fetch(request, serverRef) {
      const url = new URL(request.url);

      if (
        url.pathname === '/api/v1/orchestrator' &&
        opts &&
        handleOrchestratorUpgrade(
          request,
          serverRef,
          opts.configStore,
          opts.repoDir,
          opts.registry,
        )
      ) {
        return undefined;
      }

      if (url.pathname === '/api/v1/ws') {
        const upgraded = serverRef.upgrade(request, {
          data: { type: 'broadcast' } as any,
        });
        if (upgraded) return undefined;
        return new Response('WebSocket upgrade failed', { status: 400 });
      }

      return app.fetch(request);
    },
    websocket: {
      open(ws: any) {
        if (ws.data?.type === 'broadcast') {
          broadcastSockets.add(ws);
        } else {
          orchestratorSockets.add(ws);
          onOrchestratorWSOpen(ws);
        }
      },
      message(ws: any, message: any) {
        if (ws.data?.type === 'broadcast') return;
        onOrchestratorWSMessage(ws, message);
      },
      close(ws: any) {
        if (ws.data?.type === 'broadcast') {
          broadcastSockets.delete(ws);
        } else {
          orchestratorSockets.delete(ws);
          onOrchestratorWSClose(ws);
        }
      },
    },
  });

  server.ref();
  const originalStop = server.stop.bind(server);
  server.stop = (closeActiveConnections?: boolean) => {
    unsubscribe();
    return originalStop(closeActiveConnections);
  };

  return server;
}
