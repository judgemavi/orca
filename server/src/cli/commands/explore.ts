import type { Command } from 'commander';
import {
  buildExploreContext,
  listTrackedFiles,
  readExploreContext,
  writeExploreContext,
} from '../../domain/explore';
import {
  availableTools,
  type ToolPluginRegistry,
  toolModels,
} from '../../plugin/registry';
import { printJSON } from '../format';
import { confirm, pickFromList } from '../helpers';

export function registerExploreCommands(
  program: Command,
  repoDir: string,
  registry: ToolPluginRegistry,
) {
  const cmd = program
    .command('explore')
    .description('Explore context operations');

  cmd
    .command('run')
    .option('--tool <tool>', 'explore tool')
    .option('--model <model>', 'explore model')
    .action(async (opts: { tool?: string; model?: string }) => {
      if (canPrompt()) {
        const ok = await confirm('Run explore context generation?', true);
        if (!ok) {
          printJSON({ status: 'cancelled' });
          return;
        }
      }

      const tools = availableTools(registry);
      const tool = (opts.tool ?? '').trim() || (await resolveTool(tools));
      const models = toolModels(registry, tool);
      const model =
        (opts.model ?? '').trim() || (await resolveModel(tool, models));

      const files = await listTrackedFiles(repoDir);
      const path = await writeExploreContext(
        repoDir,
        buildExploreContext(files),
      );
      printJSON({
        status: 'completed',
        path,
        files: files.length,
        tool,
        model,
      });
    });

  cmd.command('get').action(async () => {
    const path = `${repoDir}/.orca/explore_context.md`;
    const content = await readExploreContext(repoDir);
    printJSON({ path, content });
  });

  cmd
    .command('set')
    .requiredOption('--text <text>', 'context text')
    .action(async (opts: { text: string }) => {
      const path = await writeExploreContext(repoDir, opts.text);
      printJSON({ path });
    });
}

async function resolveTool(tools: string[]): Promise<string> {
  if (tools.length === 0) return 'explore';
  if (!canPrompt()) return tools[0] as string;
  return pickFromList(
    'Explore tool',
    tools.map((tool) => ({ label: tool, value: tool })),
    tools[0] as string,
  );
}

async function resolveModel(tool: string, models: string[]): Promise<string> {
  if (models.length === 0) return '';
  if (!canPrompt()) return models[0] as string;
  return pickFromList(
    `Explore model (${tool})`,
    models.map((model) => ({ label: model, value: model })),
    models[0] as string,
  );
}

function canPrompt(): boolean {
  return Boolean(process.stdin.isTTY) && !Bun.argv.includes('--json');
}
