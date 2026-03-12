import type { Hono } from 'hono';
import type { OrcaDrizzleDB } from '../db/connection';
import type { ToolPluginRegistry } from '../plugin/registry';
import {
  handleOrchestratorUpgrade,
  type OrchestratorWebSocket,
  type OrchestratorWSData,
  onOrchestratorWSClose,
  onOrchestratorWSMessage,
  onOrchestratorWSOpen,
} from './handlers/orchestrator';

export function startHTTPServer(
  app: Hono,
  port: number,
  opts?: {
    db: OrcaDrizzleDB;
    repoDir: string;
    registry: ToolPluginRegistry;
  },
) {
  const server = Bun.serve<OrchestratorWSData>({
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
          opts.db,
          opts.repoDir,
          opts.registry,
        )
      ) {
        return undefined;
      }

      return app.fetch(request);
    },
    websocket: {
      open(ws: OrchestratorWebSocket) {
        onOrchestratorWSOpen(ws);
      },
      message(_: OrchestratorWebSocket, message: string | Buffer<ArrayBuffer>) {
        onOrchestratorWSMessage(message);
      },
      close(ws: OrchestratorWebSocket) {
        onOrchestratorWSClose(ws);
      },
    },
  });

  server.ref();
  return server;
}
