import type { Command } from 'commander';
import {
  buildExploreContext,
  listTrackedFiles,
  readExploreContext,
  writeExploreContext,
} from '../../domain/explore';
import {
  refreshMemoryEntries,
  syncMemoryWithGit,
} from '../../domain/memory-sync';
import type { MemoryStore } from '../../store/memory';
import { printJSON } from '../format';

export function registerMemoryCommands(
  program: Command,
  repoDir: string,
  memory: MemoryStore,
) {
  const cmd = program
    .command('memory')
    .alias('m')
    .description('Memory operations');

  cmd
    .command('list')
    .alias('ls')
    .option('-c, --category <category>', 'memory category')
    .option('--tag <tag>', 'tag filter')
    .option('--q <query>', 'full-text query')
    .option('-l, --limit <limit>', 'result limit', '50')
    .action(
      async (opts: {
        category?: string;
        tag?: string;
        q?: string;
        limit: string;
      }) => {
        const limit = Math.max(
          1,
          Math.min(Number.parseInt(opts.limit, 10) || 50, 500),
        );
        if ((opts.q ?? '').trim()) {
          const results = await memory.searchWithScores(opts.q ?? '', limit);
          printJSON(results.map(({ entry, score }) => ({ ...entry, score })));
          return;
        }
        const rows = await memory.list({
          category: opts.category as any,
          tag: opts.tag,
        });
        printJSON(rows.slice(0, limit));
      },
    );

  cmd.command('get <id>').action(async (id: string) => {
    const entry = await memory.get(id);
    if (!entry) throw new Error(`memory entry not found: ${id}`);
    printJSON({
      entry,
      usedByTasks: await memory.findUsedByTasks(id),
      supersedes: await memory.findSupersededIDs(id),
    });
  });

  cmd
    .command('update <id>')
    .option('--content <content>', 'content text')
    .option('--confidence <confidence>', 'confidence value')
    .option('-c, --category <category>', 'category value')
    .action(
      async (
        id: string,
        opts: { content?: string; confidence?: string; category?: string },
      ) => {
        await memory.update(id, {
          content: opts.content,
          confidence: opts.confidence
            ? Number.parseFloat(opts.confidence)
            : undefined,
          category: opts.category as any,
        });
        printJSON(await memory.get(id));
      },
    );

  cmd.command('delete <id>').action(async (id: string) => {
    await memory.delete(id);
    printJSON({ deleted: id });
  });

  cmd.command('status').action(async () => {
    const entries = await memory.list();
    const staleCount = entries.filter((e) => e.stale).length;
    const categories: Record<string, number> = {};
    for (const e of entries) {
      categories[e.category] = (categories[e.category] ?? 0) + 1;
    }
    printJSON({
      total: entries.length,
      stale: staleCount,
      active: entries.length - staleCount,
      categories,
    });
  });

  cmd
    .command('search <query>')
    .alias('s')
    .option('-l, --limit <limit>', 'result limit', '20')
    .action(async (query: string, opts: { limit: string }) => {
      const limit = Math.max(
        1,
        Math.min(Number.parseInt(opts.limit, 10) || 20, 200),
      );
      const results = await memory.searchWithScores(query, limit);
      printJSON(results.map(({ entry, score }) => ({ ...entry, score })));
    });

  cmd.command('sync').action(async () => {
    printJSON(await syncMemoryWithGit(repoDir, memory));
  });

  cmd
    .command('refresh')
    .option('--entry <id>', 'specific entry id')
    .action(async (opts: { entry?: string }) => {
      const entryID = (opts.entry ?? '').trim();
      printJSON(await refreshMemoryEntries(repoDir, memory, entryID));
    });

  cmd
    .command('reembed')
    .description('Re-generate all embeddings (e.g. after model change)')
    .action(async () => {
      const count = await memory.reembedAll();
      printJSON({ reembedded: count });
    });

  const exploreCmd = cmd
    .command('explore')
    .description('Explore context operations');
  exploreCmd
    .command('run')
    .option('--tool <tool>', 'explore tool')
    .option('--model <model>', 'explore model')
    .action(async (_: { tool?: string; model?: string }) => {
      const files = await listTrackedFiles(repoDir);
      const path = await writeExploreContext(
        repoDir,
        buildExploreContext(files),
      );
      printJSON({ status: 'completed', path, files: files.length });
    });
  exploreCmd.command('get').action(async () => {
    const content = await readExploreContext(repoDir);
    printJSON({ path: `${repoDir}/.orca/explore_context.md`, content });
  });
  exploreCmd
    .command('set')
    .requiredOption('--text <text>', 'context text')
    .action(async (opts: { text: string }) => {
      const path = await writeExploreContext(repoDir, opts.text);
      printJSON({ path });
    });
}
