import type { Command } from 'commander';
import type { InteractionStore } from '../../store/interactions';
import type { StoredInteraction } from '../../store/types';
import { isJSONMode, printJSON, printTable } from '../format';
import { short } from '../helpers';

export function registerOpsCommand(
  program: Command,
  interactions: InteractionStore,
) {
  program
    .command('ops')
    .description('List running/recent operations (interactions)')
    .option('--all', 'show historical operations')
    .option('--limit <n>', 'max rows to return', '50')
    .action(async (opts: { all?: boolean; limit?: string }) => {
      const limit = clampLimit(opts.limit);
      const sinceISO = opts.all
        ? ''
        : new Date(Date.now() - 5 * 60_000).toISOString();
      const operations = await interactions.listOperations({
        all: Boolean(opts.all),
        sinceISO,
        limit,
      });

      if (isJSONMode()) {
        printJSON({
          all: Boolean(opts.all),
          since: sinceISO || null,
          count: operations.length,
          operations,
        });
        return;
      }

      console.log(
        printTable(
          operations.map((item) => ({
            id: short(item.id),
            phase: item.phase,
            task: item.taskId ? short(item.taskId) : '-',
            tool: item.tool,
            status: item.status,
            elapsed: formatElapsed(item),
            error: clip(item.error ?? '', 60),
          })),
        ),
      );
    });
}

function formatElapsed(item: StoredInteraction): string {
  const startMS = Date.parse(item.startedAt);
  const endMS = item.finishedAt ? Date.parse(item.finishedAt) : Date.now();
  if (!Number.isFinite(startMS) || !Number.isFinite(endMS) || endMS < startMS)
    return '-';
  const total = Math.floor((endMS - startMS) / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0
    ? `${minutes}m${String(seconds).padStart(2, '0')}s`
    : `${seconds}s`;
}

function clampLimit(raw: string | undefined): number {
  const parsed = Number.parseInt((raw ?? '').trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 50;
  return Math.min(parsed, 500);
}

function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 3)}...`;
}
