import type { Command } from 'commander';
import {
  availableTools,
  type ToolPluginRegistry,
  toolModels,
} from '../../plugin/registry';
import type { ConfigStore } from '../../store/config';
import type { InteractionConfig, InteractionType } from '../../types';
import { INTERACTION_TYPES } from '../../types';
import { printJSON } from '../format';
import { pickFromList, textInput } from '../helpers';

export function registerConfigCommands(
  program: Command,
  configStore: ConfigStore,
  registry: ToolPluginRegistry,
) {
  const config = program.command('config').description('Config operations');

  config.command('get').action(async () => {
    printJSON(await configStore.load());
  });

  config
    .command('set')
    .option('--json <json>', 'JSON patch string')
    .action(async (opts: { json?: string }) => {
      let patch: unknown;
      if ((opts.json ?? '').trim()) {
        patch = JSON.parse(opts.json as string);
      } else {
        if (!canPrompt()) {
          throw new Error('--json is required in non-interactive mode');
        }
        patch = await buildInteractivePatch(configStore, registry);
      }
      const updated = await configStore.patch(patch);
      printJSON(updated);
    });
}

async function buildInteractivePatch(
  configStore: ConfigStore,
  registry: ToolPluginRegistry,
): Promise<Record<string, unknown>> {
  const current = await configStore.load();
  const allTools = availableTools(registry);
  const enabled = current.tools.filter((t) => allTools.includes(t));
  const tools = enabled.length > 0 ? enabled : allTools;

  const orchTool =
    tools.length === 1
      ? tools[0]!
      : await pickFromList(
          'Orchestrator tool',
          tools.map((t) => ({ label: t, value: t })),
          tools.includes(current.orchestrator?.tool)
            ? current.orchestrator.tool
            : tools[0],
        );
  const orchModels = toolModels(registry, orchTool);
  const orchModel =
    orchModels.length > 0
      ? await pickFromList(
          'Orchestrator model',
          orchModels.map((m) => ({ label: m, value: m })),
          orchModels.includes(current.orchestrator?.model)
            ? current.orchestrator.model
            : orchModels[0],
        )
      : '';

  const interactions = {} as Record<InteractionType, InteractionConfig>;
  for (const type of INTERACTION_TYPES) {
    const existing = current.interactions?.[type];
    const tool =
      tools.length === 1
        ? tools[0]!
        : await pickFromList(
            `${type} tool`,
            tools.map((t) => ({ label: t, value: t })),
            tools.includes(existing?.tool) ? existing.tool : tools[0],
          );
    const models = toolModels(registry, tool);
    const model =
      models.length > 0
        ? await pickFromList(
            `${type} model`,
            models.map((m) => ({ label: m, value: m })),
            models.includes(existing?.model) ? existing.model : models[0],
          )
        : '';
    interactions[type] = { tool, model };
  }

  const branch = await textInput('Integration branch', {
    defaultValue: current.project.integrationBranch,
    required: true,
  });
  const maxParallelRaw = await textInput('Max parallel workers', {
    defaultValue: String(current.workers.maxParallel),
    required: true,
    validate: (value) => {
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed < 1) {
        return 'must be integer >= 1';
      }
    },
  });
  const maxParallel = Number.parseInt(maxParallelRaw, 10);

  return {
    interactions,
    orchestrator: { tool: orchTool, model: orchModel },
    project: { integrationBranch: branch },
    workers: { maxParallel },
  };
}

function canPrompt(): boolean {
  return Boolean(process.stdin.isTTY) && !Bun.argv.includes('--json');
}
