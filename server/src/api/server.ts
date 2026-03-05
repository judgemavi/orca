import type { Hono } from 'hono';
import type { ToolPluginRegistry } from '../plugin/registry';
import type { ConfigStore } from '../store/config';
import {
  handleOrchestratorUpgrade,
  onOrchestratorWSClose,
  onOrchestratorWSMessage,
  onOrchestratorWSOpen,
} from './handlers/orchestrator';

export function startHTTPServer(
  app: Hono,
  port: number,
  opts?: {
    configStore: ConfigStore;
    repoDir: string;
    registry: ToolPluginRegistry;
  },
) {
  const orchestratorSockets = new Set<any>();

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

      return app.fetch(request);
    },
    websocket: {
      open(ws: any) {
        orchestratorSockets.add(ws);
        onOrchestratorWSOpen(ws);
      },
      message(ws: any, message: any) {
        onOrchestratorWSMessage(ws, message);
      },
      close(ws: any) {
        orchestratorSockets.delete(ws);
        onOrchestratorWSClose(ws);
      },
    },
  });

  server.ref();
  return server;
}
