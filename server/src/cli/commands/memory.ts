import type { Command } from 'commander';
import {
  refreshMemoryEntries,
  syncMemoryWithGit,
} from '../../domain/memory-sync';
import type { MemoryStore } from '../../store/memory';
import { printJSON } from '../format';
import { confirm, pickFromList } from '../helpers';

export function registerMemoryCommands(
  program: Command,
  repoDir: string,
  memory: MemoryStore,
) {
  const cmd = program.command('memory').description('Memory operations');

  cmd
    .command('list')
    .option('--category <category>', 'memory category')
    .option('--tag <tag>', 'tag filter')
    .option('--q <query>', 'full-text query')
    .option('--limit <limit>', 'result limit', '50')
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
          printJSON(await memory.search(opts.q ?? '', limit));
          return;
        }
        const rows = await memory.list({
          category: opts.category as any,
          tag: opts.tag,
        });
        const sliced = rows.slice(0, limit);
        if (
          canPrompt() &&
          !(opts.category ?? '').trim() &&
          !(opts.tag ?? '').trim()
        ) {
          await browseMemory(memory, sliced);
          return;
        }
        printJSON(sliced);
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
    .option('--category <category>', 'category value')
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

  cmd
    .command('delete [id]')
    .option('-y, --yes', 'skip confirmation')
    .action(async (id: string | undefined, opts: { yes?: boolean }) => {
      let entryID = (id ?? '').trim();
      if (!entryID) {
        if (!canPrompt())
          throw new Error('id required in non-interactive mode');
        const rows = (await memory.list()).slice(0, 200);
        if (rows.length === 0) throw new Error('no memory entries found');
        entryID = await pickFromList(
          'Select memory entry to delete',
          rows.map((entry) => ({
            label: `${entry.id.slice(0, 8)}  ${entry.category}  ${entry.content.slice(0, 60)}`,
            value: entry.id,
          })),
          rows[0]?.id,
        );
      }

      if (!opts.yes) {
        const ok = await confirm(`Delete memory entry ${entryID}?`, false);
        if (!ok) {
          printJSON({ deleted: null, cancelled: true });
          return;
        }
      }

      await memory.delete(entryID);
      printJSON({ deleted: entryID });
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
}

async function browseMemory(
  memory: MemoryStore,
  rows: Awaited<ReturnType<MemoryStore['list']>>,
) {
  if (rows.length === 0) {
    printJSON([]);
    return;
  }

  const selected = await pickFromList(
    'Browse memory entries',
    [
      { label: 'Show table only', value: '__list__' },
      ...rows.map((entry) => ({
        label: `${entry.id.slice(0, 8)}  ${entry.category}  ${entry.content.slice(0, 60)}`,
        value: entry.id,
      })),
    ],
    '__list__',
  );

  if (selected === '__list__') {
    printJSON(rows);
    return;
  }

  const entry = await memory.get(selected);
  if (!entry) throw new Error(`memory entry not found: ${selected}`);
  printJSON({
    entry,
    usedByTasks: await memory.findUsedByTasks(selected),
    supersedes: await memory.findSupersededIDs(selected),
  });
}

function canPrompt(): boolean {
  return Boolean(process.stdin.isTTY) && !Bun.argv.includes('--json');
}
