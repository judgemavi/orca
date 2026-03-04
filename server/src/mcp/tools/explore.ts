import { z } from 'zod';
import { readExploreContext, runExplore } from '../../domain/explore';
import { getMemorySyncStatus } from '../../domain/memory-sync';
import type { DriverRegistry } from '../../driver/registry';
import type { ConfigStore } from '../../store/config';
import type { InteractionStore } from '../../store/interactions';
import type { MemoryStore } from '../../store/memory';
import { defineTool } from '../define-tool';
import type { Tool } from '../types';

const exploreSchema = z.object({
  query: z.preprocess(
    (value) => (value === undefined ? undefined : (value ?? '')),
    z.coerce.string().optional(),
  ),
  tool: z.preprocess(
    (value) => (value === undefined ? undefined : (value ?? '')),
    z.coerce.string().optional(),
  ),
  model: z.preprocess(
    (value) => (value === undefined ? undefined : (value ?? '')),
    z.coerce.string().optional(),
  ),
});

const exploreStatusSchema = z.object({});

export function exploreTools(deps: {
  repoDir: string;
  memory: MemoryStore;
  interactions: InteractionStore;
  configStore: ConfigStore;
  registry: DriverRegistry;
}): Tool[] {
  return [
    defineTool({
      name: 'explore',
      description: 'Run repository exploration and write context file',
      schema: exploreSchema,
      handler: async (input) => {
        const result = await runExplore({
          repoDir: deps.repoDir,
          interactions: deps.interactions,
          memory: deps.memory,
          config: await deps.configStore.load(),
          registry: deps.registry,
          query: input.query ?? '',
          toolOverride: input.tool ?? '',
          modelOverride: input.model ?? '',
        });
        return {
          status: 'completed',
          ...result,
        };
      },
    }),
    defineTool({
      name: 'explore_status',
      description: 'Get explore context status',
      schema: exploreStatusSchema,
      handler: async () => {
        const content = await readExploreContext(deps.repoDir);
        const sync = await getMemorySyncStatus(deps.repoDir, deps.memory);
        const staleCount = (await deps.memory.findStaleEntries()).length;
        return {
          exists: Boolean(content.trim()),
          stale: staleCount > 0 || sync.syncNeeded,
          ageMinutes: 0,
        };
      },
    }),
  ];
}
