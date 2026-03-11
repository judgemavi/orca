import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import type { OrcaDrizzleDB } from '../../db/connection';
import type { TaskEntry } from '../../db/schema';
import { cleanupTaskArtifacts } from '../../domain/task-cleanup';
import { cleanupSchema } from '../../schemas/cleanup';
import { gitRun } from '../../shared/git';
import * as taskStore from '../../store/tasks';
import type { EventSink } from '../ws';
import { asyncOp } from './async-op';
import { broadcast } from './utils';

interface WorktreeEntry {
  path: string;
  branch: string;
  taskID: string;
}

export function cleanupRoutes(deps: {
  repoDir: string;
  db: OrcaDrizzleDB;
  sink: EventSink;
}) {
  return new Hono().post(
    '/cleanup',
    zValidator('json', cleanupSchema),
    async (c) => {
      const body = c.req.valid('json');
      const dryRun = Boolean(body.dryRun);
      const stale = await listStaleTaskWorktrees(deps.repoDir, deps.db);

      if (dryRun) {
        return c.json({
          removed: stale.length,
          worktrees: stale.map((entry) => entry.branch || entry.path),
          dryRun: true,
        });
      }

      asyncOp(deps.sink, {
        started: {
          name: 'cleanup.started',
        },
        completed: {
          name: 'cleanup.completed',
          payload: ({ result }) => result,
        },
        run: async () => {
          const removed: string[] = [];
          const warnings: string[] = [];

          for (const entry of stale) {
            const cleanup = await cleanupTaskArtifacts({
              repoDir: deps.repoDir,
              taskID: entry.taskID,
            });
            if (cleanup.worktreeRemoved || cleanup.removedBranches.length > 0) {
              removed.push(entry.taskID);
              broadcast(deps.sink, 'cleanup.progress', {
                taskId: entry.taskID,
                branch: entry.branch,
              });
            }
            if (cleanup.warnings.length > 0) {
              warnings.push(...cleanup.warnings);
            }
          }

          return {
            removed: removed.length,
            taskIds: removed,
            warnings,
          };
        },
      });

      return c.json({ status: 'running' }, 202);
    },
  );
}

async function listStaleTaskWorktrees(
  repoDir: string,
  db: OrcaDrizzleDB,
): Promise<WorktreeEntry[]> {
  const listed = await listWorktrees(repoDir);
  const stale: WorktreeEntry[] = [];

  for (const item of listed) {
    if (!item.taskID) continue;
    if (!item.branch.startsWith('orca/task-')) continue;

    let task: TaskEntry | null = null;
    try {
      task = await taskStore.getTask(db, item.taskID);
    } catch {
      stale.push(item);
      continue;
    }
    if (
      task.status === 'approved' ||
      task.status === 'failed' ||
      task.status === 'merged'
    ) {
      stale.push(item);
    }
  }

  return stale;
}

async function listWorktrees(repoDir: string): Promise<WorktreeEntry[]> {
  const result = await gitRun(repoDir, ['worktree', 'list', '--porcelain']);
  if (result.exitCode !== 0) return [];

  const entries: WorktreeEntry[] = [];
  const blocks = result.stdout
    .split('\n\n')
    .map((block) => block.trim())
    .filter(Boolean);
  for (const block of blocks) {
    const lines = block.split('\n');
    const worktreeLine = lines.find((line) => line.startsWith('worktree '));
    if (!worktreeLine) continue;
    const path = worktreeLine.slice('worktree '.length).trim();
    const branchLine = lines.find((line) => line.startsWith('branch '));
    const branch = branchLine
      ? branchLine.slice('branch '.length).replace('refs/heads/', '').trim()
      : '';
    if (
      branch === 'main' ||
      branch === 'master' ||
      branch === 'orca/integration'
    )
      continue;
    entries.push({
      path,
      branch,
      taskID: extractTaskID(branch, path),
    });
  }
  return entries;
}

function extractTaskID(branch: string, path: string): string {
  const source = branch.startsWith('orca/task-')
    ? branch.slice('orca/'.length)
    : (path.replace(/\/+$/g, '').split('/').pop() ?? '');
  const match = source.match(/^task-([^-]+)(?:--.*)?$/);
  return match?.[1] ?? '';
}
