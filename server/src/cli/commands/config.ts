import type { Command } from 'commander';
import {
  availableTools,
  type DriverRegistry,
  toolModels,
} from '../../driver/registry';
import type { ConfigStore } from '../../store/config';
import { printJSON } from '../format';
import { pickFromList, textInput } from '../helpers';

export function registerConfigCommands(
  program: Command,
  configStore: ConfigStore,
  registry: DriverRegistry,
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
  registry: DriverRegistry,
): Promise<Record<string, unknown>> {
  const current = await configStore.load();
  const tools = availableTools(registry);
  const defaultTool = await pickFromList(
    'Default tool',
    tools.map((tool) => ({ label: tool, value: tool })),
    tools.includes(current.defaultTool) ? current.defaultTool : tools[0],
  );
  const models = toolModels(registry, defaultTool);
  const defaultModel =
    models.length > 0
      ? await pickFromList(
          `Default model (${defaultTool})`,
          models.map((model) => ({ label: model, value: model })),
          models.includes(current.defaultModel)
            ? current.defaultModel
            : models[0],
        )
      : '';

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
    defaultTool: defaultTool,
    defaultModel: defaultModel,
    project: {
      integrationBranch: branch,
    },
    workers: {
      maxParallel: maxParallel,
    },
  };
}

function canPrompt(): boolean {
  return Boolean(process.stdin.isTTY) && !Bun.argv.includes('--json');
}
