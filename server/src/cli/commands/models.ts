import type { Command } from 'commander';
import type { DriverRegistry } from '../../driver/registry';
import { availableTools, toolModels } from '../../driver/registry';
import { printJSON } from '../format';

export function registerModelsCommand(
  program: Command,
  registry: DriverRegistry,
) {
  program
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
}
