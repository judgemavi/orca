import path from 'node:path';
import { gitOutput, gitRunStrict as gitRun } from '../shared/git';
import type { Task } from '../types/models';

function resolveWorktreeRoot(repoDir: string, configuredPath: string): string {
  const trimmed = configuredPath.trim();
  if (!trimmed) {
    return `${repoDir}/.orca/worktrees`;
  }

  if (path.isAbsolute(trimmed)) {
    return trimTrailingSlash(trimmed);
  }

  return trimTrailingSlash(`${repoDir}/${trimmed}`);
}

function formatTaskDirName(taskID: string, title: string): string {
  const slug = slugify(title);
  if (!slug) {
    return `task-${taskID}`;
  }
  return `task-${taskID}--${slug}`;
}

function slugify(value: string): string {
  const source = value.toLowerCase().trim();
  if (!source) return '';

  let out = '';
  let prevDash = true;

  for (const char of source) {
    if ((char >= 'a' && char <= 'z') || (char >= '0' && char <= '9')) {
      out += char;
      prevDash = false;
      continue;
    }
    if (!prevDash) {
      out += '-';
      prevDash = true;
    }
  }

  out = out.replace(/-+$/, '');
  if (out.length <= 50) return out;

  const clipped = out.slice(0, 50);
  const lastDash = clipped.lastIndexOf('-');
  if (lastDash > 10) return clipped.slice(0, lastDash);
  return clipped;
}

export async function ensureIntegrationBranch(
  repoDir: string,
  branch: string,
): Promise<void> {
  const exists = await gitRun(repoDir, ['rev-parse', '--verify', branch], true);
  if (exists.code === 0) return;

  const create = await gitRun(repoDir, ['branch', branch], true);
  if (create.code !== 0 && !/already exists/i.test(create.stderr)) {
    throw new Error(
      `failed to create integration branch ${JSON.stringify(branch)}: ${create.stderr}`,
    );
  }
}

export async function findTaskWorktree(
  repoDir: string,
  taskID: string,
): Promise<string> {
  const output = await gitOutput(repoDir, ['worktree', 'list', '--porcelain']);
  const lines = output.split('\n');
  for (const line of lines) {
    if (!line.startsWith('worktree ')) continue;
    const wtPath = line.slice('worktree '.length).trim();
    const name = path.basename(wtPath);
    if (name === `task-${taskID}` || name.startsWith(`task-${taskID}--`)) {
      return wtPath;
    }
  }
  return '';
}

export async function ensureTaskWorktree(input: {
  repoDir: string;
  worktreeDir: string;
  integrationBranch: string;
  task: Pick<Task, 'id' | 'title'>;
}): Promise<string> {
  const existing = await findTaskWorktree(input.repoDir, input.task.id);
  if (existing) return existing;

  const root = resolveWorktreeRoot(input.repoDir, input.worktreeDir);
  await Bun.$`mkdir -p ${root}`;

  const dirName = formatTaskDirName(input.task.id, input.task.title);
  const worktreePath = `${root}/${dirName}`;
  const branchName = `orca/${dirName}`;

  const added = await gitRun(
    input.repoDir,
    [
      'worktree',
      'add',
      worktreePath,
      '-b',
      branchName,
      input.integrationBranch,
    ],
    true,
  );

  if (added.code === 0) return worktreePath;

  const branchFallback = await gitRun(
    input.repoDir,
    ['worktree', 'add', worktreePath, branchName],
    true,
  );
  if (branchFallback.code === 0) return worktreePath;

  throw new Error(
    `failed to create worktree for task ${input.task.id}: ${added.stderr || branchFallback.stderr}`,
  );
}

function trimTrailingSlash(p: string): string {
  return p.replace(/\/+$/, '');
}
