import type { Command } from 'commander';
import { OllamaEmbeddingPlugin } from '../../embedding/ollama';
import type { EmbeddingPlugin } from '../../embedding/types';
import {
  availableTools,
  type ToolPluginRegistry,
  toolModels,
} from '../../plugin/registry';
import type { ConfigStore } from '../../store/config';
import type { InteractionConfig, InteractionType } from '../../types';
import { INTERACTION_TYPES } from '../../types';
import { printJSON } from '../format';
import { confirm, pickFromList, textInput } from '../helpers';

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
    const autoRun = await confirm(
      `${type} auto-run?`,
      existing?.autoRun ?? true,
    );
    interactions[type] = { tool, model, autoRun };
  }

  // Embeddings — discover reachable providers, prompt config fields from plugin
  const embeddingConfig: Record<string, unknown> = {};
  const embeddingPlugins: EmbeddingPlugin[] = [new OllamaEmbeddingPlugin()];
  const reachablePlugins: EmbeddingPlugin[] = [];
  for (const plugin of embeddingPlugins) {
    if (await plugin.reachable()) reachablePlugins.push(plugin);
  }

  if (reachablePlugins.length > 0) {
    const choices = [
      ...reachablePlugins.map((p) => ({ label: p.name(), value: p.name() })),
      { label: 'None (FTS only)', value: 'none' },
    ];
    const pick = await pickFromList(
      'Embedding provider',
      choices,
      current.embeddings?.provider &&
        reachablePlugins.some((p) => p.name() === current.embeddings?.provider)
        ? current.embeddings.provider
        : reachablePlugins[0]!.name(),
    );

    if (pick !== 'none') {
      const plugin = reachablePlugins.find((p) => p.name() === pick)!;
      embeddingConfig.provider = plugin.name();
      const currentEmbConf = (current.embeddings ?? {}) as Record<
        string,
        unknown
      >;

      for (const field of plugin.configFields()) {
        const existing = currentEmbConf[field.key];
        const defaultVal =
          typeof existing === 'string' ? existing : (field.defaultValue ?? '');
        embeddingConfig[field.key] = await textInput(
          field.label + (field.hint ? ` (${field.hint})` : ''),
          { defaultValue: defaultVal },
        );
      }

      if (plugin.setup) {
        const configured = new OllamaEmbeddingPlugin({
          model: embeddingConfig.model as string | undefined,
        });
        const ready = await configured.available();
        if (!ready) {
          const doPull = await confirm(
            'Model not found — set it up now?',
            true,
          );
          if (doPull) {
            console.log('Setting up embedding model...');
            try {
              await configured.setup((status) =>
                process.stdout.write(`\r  ${status}  `),
              );
              console.log('\n  Embedding model ready');
            } catch (err) {
              console.error(
                `\n  Setup failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
        }
      }
    }
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
    ...(embeddingConfig.provider ? { embeddings: embeddingConfig } : {}),
  };
}

function canPrompt(): boolean {
  return Boolean(process.stdin.isTTY) && !Bun.argv.includes('--json');
}
