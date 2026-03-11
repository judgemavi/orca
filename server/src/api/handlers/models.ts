import { Hono } from 'hono';
import type { ToolPluginRegistry } from '../../plugin/registry';
import { availableTools, toolModels } from '../../plugin/registry';
import type { ModelInfo } from '../../types/api';

export function modelRoutes(registry: ToolPluginRegistry) {
  return new Hono().get('/config/models', (c) => {
    const requested = c.req.query('tool')?.trim();
    if (requested) {
      return c.json({
        tools: {
          [requested]: toModelInfo(requested, toolModels(registry, requested)),
        },
      });
    }

    const tools = Object.fromEntries(
      availableTools(registry).map((tool) => [
        tool,
        toModelInfo(tool, toolModels(registry, tool)),
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
