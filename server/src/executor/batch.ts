import type { TaskStatus } from '@orca/types';
import {
  ensureIntegrationBranch as ensureIntegrationBranchDomain,
  ensureTaskWorktree as ensureTaskWorktreeDomain,
  findTaskWorktree,
} from '../domain/worktree';
import { toErrorMessage } from '../shared/errors';
import { gitRun } from '../shared/git';
import { getTask, updateTaskStatus } from '../store/tasks';
import type { ExecutorDeps } from './types';
import { RUNNABLE_STATUSES } from './types';

export function dedupeTaskIDs(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }

  return out;
}

export async function validateRunnableTaskStatuses(
  deps: Pick<ExecutorDeps, 'db'>,
  taskIDs: string[],
): Promise<void> {
  for (const taskID of taskIDs) {
    const task = await getTask(deps.db, taskID);
    if (!task) {
      throw new Error(`task not found: ${taskID}`);
    }
    if (!RUNNABLE_STATUSES.has(task.status as TaskStatus)) {
      throw new Error(
        `task ${taskID} is ${task.status}; runnable statuses are: pending, planned, failed, review`,
      );
    }
  }
}

export async function ensureIntegrationBranch(
  deps: Pick<ExecutorDeps, 'repoDir' | 'config'>,
): Promise<void> {
  await ensureIntegrationBranchDomain(
    deps.repoDir,
    deps.config.project.integrationBranch,
  );
}

export async function ensureTaskWorktree(
  deps: Pick<ExecutorDeps, 'repoDir' | 'config'>,
  task: Parameters<typeof ensureTaskWorktreeDomain>[0]['task'],
): Promise<string> {
  return ensureTaskWorktreeDomain({
    repoDir: deps.repoDir,
    worktreeDir: deps.config.project.worktreeDir,
    integrationBranch: deps.config.project.integrationBranch,
    task,
  });
}

export async function prepareBatch(
  deps: Pick<ExecutorDeps, 'db' | 'repoDir' | 'config' | 'sink'>,
  taskIDs: string[],
): Promise<void> {
  const preparedTaskIDs: string[] = [];

  for (const taskID of taskIDs) {
    const task = await getTask(deps.db, taskID);
    if (!task) {
      await rollbackPreparation(deps, preparedTaskIDs);
      throw new Error(`failed to prepare task ${taskID}: task not found`);
    }

    try {
      const existing = await findTaskWorktree(deps.repoDir, taskID);
      if (existing) continue;
      await ensureTaskWorktree(deps, task);
      preparedTaskIDs.push(taskID);
    } catch (error) {
      await rollbackPreparation(deps, preparedTaskIDs);
      throw new Error(
        `failed to prepare task ${taskID}: ${toErrorMessage(error)}`,
      );
    }
  }
}

async function rollbackPreparation(
  deps: Pick<ExecutorDeps, 'db' | 'repoDir' | 'sink'>,
  taskIDs: string[],
): Promise<void> {
  for (const taskID of taskIDs) {
    await removeTaskWorktree(deps, taskID).catch(() => {});
    try {
      await updateTaskStatus(deps.db, deps.sink, taskID, 'planned');
    } catch {
      // Ignore reset failures during rollback.
    }
  }
}

async function removeTaskWorktree(
  deps: Pick<ExecutorDeps, 'repoDir'>,
  taskID: string,
): Promise<void> {
  const worktreePath = await findTaskWorktree(deps.repoDir, taskID).catch(
    () => '',
  );
  if (!worktreePath) return;

  await gitRun(deps.repoDir, ['worktree', 'remove', '--force', worktreePath]);

  const branches = await gitRun(deps.repoDir, [
    'for-each-ref',
    '--format=%(refname:short)',
    `refs/heads/orca/task-${taskID}*`,
  ]);
  if (branches.exitCode !== 0) return;

  const branchNames = branches.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  for (const branch of branchNames) {
    await gitRun(deps.repoDir, ['branch', '-D', branch]);
  }
}
