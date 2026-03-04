import type { Hono } from 'hono';
import type { DriverRegistry } from '../../driver/registry';
import { availableTools, toolModels } from '../../driver/registry';
import type { ModelInfo } from '../../types';

export function registerModelHandlers(app: Hono, registry: DriverRegistry) {
  app.get('/models', (c) => {
    const requested = c.req.query('tool')?.trim();
    if (requested) {
      return c.json({
        data: {
          tools: {
            [requested]: toModelInfo(
              requested,
              toolModels(registry, requested),
            ),
          },
        },
      });
    }

    const tools = Object.fromEntries(
      availableTools(registry).map((tool) => [
        tool,
        toModelInfo(tool, toolModels(registry, tool)),
      ]),
    );
    return c.json({ data: { tools } });
  });
}

function toModelInfo(tool: string, models: string[]): ModelInfo[] {
  return models.map((id) => ({
    id,
    name: id,
    provider: tool,
  }));
}
