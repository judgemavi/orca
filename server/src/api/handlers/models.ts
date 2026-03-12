import { Hono } from 'hono';
import type { ToolPluginRegistry } from '../../plugin/registry';
import type { ModelInfo } from '../../types/api';

export function modelRoutes(registry: ToolPluginRegistry) {
  return new Hono().get('/config/models', (c) => {
    const requested = c.req.query('tool')?.trim();
    if (requested) {
      return c.json({
        tools: {
          [requested]: toModelInfo(
            requested,
            registry.get(requested)?.models() ?? [],
          ),
        },
      });
    }

    const tools = Object.fromEntries(
      registry
        .available()
        .map((tool) => [
          tool,
          toModelInfo(tool, registry.get(tool)?.models() ?? []),
        ]),
    );
    return c.json({ tools });
  });
}

function toModelInfo(tool: string, models: string[]): ModelInfo[] {
  return models.map((id) => ({
    id,
    name: id,
    provider: tool,
  }));
}
