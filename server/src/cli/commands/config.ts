import type { Command } from 'commander';
import type { OrcaDrizzleDB } from '../../db/connection';
import {
  availableTools,
  type ToolPluginRegistry,
  toolModels,
} from '../../plugin/registry';
import * as configStore from '../../store/config';
import { printJSON } from '../format';

export function registerConfigCommands(
  program: Command,
  db: OrcaDrizzleDB,
  registry: ToolPluginRegistry,
) {
  const config = program
    .command('config')
    .alias('c')
    .description('Config operations');

  config.command('get').action(async () => {
    printJSON(await configStore.loadConfig(db));
  });

  config
    .command('models')
    .option('--tool <tool>', 'tool name')
    .action((opts: { tool?: string }) => {
      const tool = (opts.tool ?? '').trim();
      if (tool) {
        printJSON({ [tool]: toolModels(registry, tool) });
        return;
      }
      const data = Object.fromEntries(
        availableTools(registry).map((name) => [
          name,
          toolModels(registry, name),
        ]),
      );
      printJSON(data);
    });

  config
    .command('set')
    .requiredOption('--json <json>', 'JSON patch string')
    .action(async (opts: { json: string }) => {
      const patch = JSON.parse(opts.json);
      await configStore.patchConfig(db, undefined, patch);
      printJSON(await configStore.loadConfig(db));
    });
}
