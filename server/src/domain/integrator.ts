import { TASK_STATUSES } from '@orca/types';
import type { OrcaDrizzleDB } from '../db/connection';
import type { Config } from '../db/schema';
import type { ToolPluginRegistry } from '../plugin/registry';
import {
  formatRefLockContentionError,
  gitRunWithRefLockRetry,
  isRefLockErrorResult,
  gitRun as sharedGitRun,
} from '../shared/git';
import type { InteractionStore } from '../store/interactions';
import * as taskStore from '../store/tasks';
import {
  mergeWithConflictResolutionUnlocked,
  readConflictFiles,
} from './conflict-resolution';
import { findTaskWorktree } from './worktree';

export interface MergeResult {
  taskId: string;
  status: typeof TASK_STATUSES.merged | typeof TASK_STATUSES.failed;
  branch: string;
  worktreePath: string;
  rebaseAttempted: boolean;
  conflicts: string[];
  error?: string;
  commitSha?: string;
}

export interface IntegratorDeps {
  repoDir: string;
  integrationBranch: string;
  db: OrcaDrizzleDB;
}

async function assertTaskMergeable(
  taskID: string,
  db: OrcaDrizzleDB,
): Promise<void> {
  const task = await taskStore.getTask(db, taskID);
  if (!task) throw new Error(`task ${taskID} not found`);

  if (
    task.status !== TASK_STATUSES.approved &&
    task.status !== TASK_STATUSES.review
  ) {
    throw new Error(
      `task ${taskID} is ${task.status}; expected approved/review`,
    );
  }

  for (const depID of task.dependsOn ?? []) {
    const dep = await taskStore.getTask(db, depID);
    if (!dep) {
      throw new Error(`dependency task ${depID} not found`);
    }
    if (dep.status !== TASK_STATUSES.merged) {
      throw new Error(`dependency ${depID} must be merged before ${taskID}`);
    }
  }
}

export async function mergeTaskWithGit(
  taskID: string,
  deps: IntegratorDeps,
): Promise<MergeResult> {
  return mergeTaskWithGitUnlocked(taskID, deps);
}

export interface ConflictResolutionDeps extends IntegratorDeps {
  config: Config;
  registry: ToolPluginRegistry;
  interactionStore: InteractionStore;
  logsDir: string;
}

export async function mergeWithConflictResolution(
  taskID: string,
  deps: ConflictResolutionDeps,
): Promise<MergeResult> {
  return mergeWithConflictResolutionUnlocked(taskID, deps, {
    mergeTaskWithGitUnlocked,
    resolveTaskBranch,
    rollbackMergedCommit,
    cleanupTaskWorktree,
    gitRun,
  });
}

async function mergeTaskWithGitUnlocked(
  taskID: string,
  deps: IntegratorDeps,
): Promise<MergeResult> {
  await assertTaskMergeable(taskID, deps.db);

  const task = await taskStore.getTask(deps.db, taskID);
  if (!task) throw new Error(`task ${taskID} not found`);

  const worktreePath = await findTaskWorktree(deps.repoDir, taskID);
  const branch = await resolveTaskBranch(deps.repoDir, taskID, worktreePath);
  const base = deps.integrationBranch.trim();

  const failed = (
    message: string,
    opts?: Partial<MergeResult>,
  ): MergeResult => ({
    taskId: taskID,
    status: TASK_STATUSES.failed,
    branch,
    worktreePath: worktreePath,
    rebaseAttempted: Boolean(opts?.rebaseAttempted),
    conflicts: opts?.conflicts ?? [],
    error: message,
  });

  const checkout = await gitRunWithRefLockRetry(deps.repoDir, [
    'checkout',
    base,
  ]);
  if (checkout.code !== 0) {
    if (isRefLockErrorResult(checkout)) {
      return failed(formatRefLockContentionError(checkout.stderr));
    }
    return failed(
      `checkout ${base} failed: ${checkout.stderr || checkout.stdout}`,
    );
  }

  const mergeMessage = `orca: merge task-${taskID}`;
  let rebaseAttempted = false;
  let conflicts: string[] = [];

  let merged = await squashMerge(deps.repoDir, branch, mergeMessage);
  if (merged.code !== 0) {
    if (isRefLockErrorResult(merged)) {
      return failed(formatRefLockContentionError(merged.stderr));
    }
    conflicts = await readConflictFiles(deps.repoDir);
    await gitRun(deps.repoDir, ['merge', '--abort'], true);
    rebaseAttempted = true;

    const rebased = await rebaseTaskBranch(
      deps.repoDir,
      base,
      branch,
      worktreePath,
    );
    if (!rebased.ok) {
      return failed(rebased.error || 'rebase failed', {
        rebaseAttempted: true,
        conflicts,
      });
    }

    merged = await squashMerge(
      deps.repoDir,
      branch,
      `${mergeMessage} (after rebase)`,
    );
    if (merged.code !== 0) {
      if (isRefLockErrorResult(merged)) {
        return failed(formatRefLockContentionError(merged.stderr), {
          rebaseAttempted: true,
          conflicts,
        });
      }
      conflicts = await readConflictFiles(deps.repoDir);
      await gitRun(deps.repoDir, ['merge', '--abort'], true);
      return failed(
        merged.stderr || merged.stdout || 'merge failed after rebase',
        {
          rebaseAttempted: true,
          conflicts,
        },
      );
    }
  }

  // Capture squash merge commit SHA before cleanup
  const mergeHead = await gitRunWithRefLockRetry(deps.repoDir, [
    'rev-parse',
    'HEAD',
  ]);
  const commitSha = mergeHead.code === 0 ? mergeHead.stdout.trim() : undefined;

  await cleanupTaskWorktree(deps.repoDir, worktreePath, branch, taskID);

  return {
    taskId: taskID,
    status: TASK_STATUSES.merged,
    branch,
    worktreePath: worktreePath,
    rebaseAttempted: rebaseAttempted,
    conflicts,
    commitSha,
  };
}

async function squashMerge(
  repoDir: string,
  branch: string,
  message: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const squash = await gitRunWithRefLockRetry(repoDir, [
    'merge',
    '--squash',
    branch,
  ]);
  if (squash.code !== 0) return squash;

  const commit = await gitRunWithRefLockRetry(repoDir, [
    'commit',
    '-m',
    message,
  ]);
  return commit;
}

async function resolveTaskBranch(
  repoDir: string,
  taskID: string,
  worktreePath: string,
): Promise<string> {
  if (worktreePath) {
    const branchFromWorktree = await gitRun(
      worktreePath,
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      true,
    );
    if (branchFromWorktree.code === 0 && branchFromWorktree.stdout.trim()) {
      return branchFromWorktree.stdout.trim();
    }
  }

  const exact = `orca/task-${taskID}`;
  const list = await gitRun(repoDir, ['branch', '--list', `${exact}*`], true);
  const candidate = list.stdout
    .split('\n')
    .map((line) => line.replace(/^[*+\s]+/, '').trim())
    .find(Boolean);

  return candidate || exact;
}

async function rebaseTaskBranch(
  repoDir: string,
  integrationBranch: string,
  branch: string,
  worktreePath: string,
): Promise<{ ok: boolean; error?: string }> {
  if (worktreePath) {
    const rebase = await gitRunWithRefLockRetry(worktreePath, [
      'rebase',
      integrationBranch,
    ]);
    if (rebase.code === 0) return { ok: true };
    if (isRefLockErrorResult(rebase)) {
      return { ok: false, error: formatRefLockContentionError(rebase.stderr) };
    }
    await gitRun(worktreePath, ['rebase', '--abort'], true);
    return {
      ok: false,
      error: rebase.stderr || rebase.stdout || 'rebase failed in worktree',
    };
  }

  const checkoutTask = await gitRunWithRefLockRetry(repoDir, [
    'checkout',
    branch,
  ]);
  if (checkoutTask.code !== 0) {
    if (isRefLockErrorResult(checkoutTask)) {
      return {
        ok: false,
        error: formatRefLockContentionError(checkoutTask.stderr),
      };
    }
    return { ok: false, error: checkoutTask.stderr || checkoutTask.stdout };
  }

  const rebased = await gitRunWithRefLockRetry(repoDir, [
    'rebase',
    integrationBranch,
  ]);
  if (rebased.code !== 0) {
    if (isRefLockErrorResult(rebased)) {
      return { ok: false, error: formatRefLockContentionError(rebased.stderr) };
    }
    await gitRun(repoDir, ['rebase', '--abort'], true);
    await gitRun(repoDir, ['checkout', integrationBranch], true);
    return { ok: false, error: rebased.stderr || rebased.stdout };
  }

  const checkoutIntegration = await gitRunWithRefLockRetry(repoDir, [
    'checkout',
    integrationBranch,
  ]);
  if (checkoutIntegration.code !== 0) {
    if (isRefLockErrorResult(checkoutIntegration)) {
      return {
        ok: false,
        error: formatRefLockContentionError(checkoutIntegration.stderr),
      };
    }
    return {
      ok: false,
      error: checkoutIntegration.stderr || checkoutIntegration.stdout,
    };
  }

  return { ok: true };
}

async function cleanupTaskWorktree(
  repoDir: string,
  worktreePath: string,
  branch: string,
  _taskID: string,
) {
  if (worktreePath) {
    await gitRun(
      repoDir,
      ['worktree', 'remove', '--force', worktreePath],
      true,
    );
  }
  // Force-delete (-D) because squash merge doesn't create a merge commit,
  // so git won't consider the branch "fully merged" for safe -d delete.
  if (branch) {
    await gitRun(repoDir, ['branch', '-D', branch], true);
  }
}

async function rollbackMergedCommit(
  repoDir: string,
): Promise<string | undefined> {
  const reset = await gitRunWithRefLockRetry(repoDir, [
    'reset',
    '--hard',
    'HEAD~1',
  ]);
  if (reset.code === 0) return undefined;
  return reset.stderr || reset.stdout || 'git reset --hard HEAD~1 failed';
}

async function gitRun(
  cwd: string,
  args: string[],
  allowFailure = false,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const result = await sharedGitRun(cwd, args);
  const stdout = result.stdout;
  const stderr = result.stderr;
  const code = result.exitCode;
  if (!allowFailure && code !== 0) {
    throw new Error(stderr || stdout || `git ${args.join(' ')} failed`);
  }
  return { code, stdout, stderr };
}
