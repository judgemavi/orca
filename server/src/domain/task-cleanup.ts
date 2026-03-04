import { toErrorMessage } from '../shared/errors';
import { gitRun as sharedGitRun } from '../shared/git';
import { findTaskWorktree } from './worktree';

export interface TaskCleanupResult {
  taskId: string;
  worktreePath: string;
  worktreeRemoved: boolean;
  removedBranches: string[];
  logsRemoved: boolean;
  warnings: string[];
}

export async function cleanupTaskArtifacts(input: {
  repoDir: string;
  taskID: string;
  removeLogs?: () => Promise<void>;
}): Promise<TaskCleanupResult> {
  const taskID = input.taskID.trim();
  const result: TaskCleanupResult = {
    taskId: taskID,
    worktreePath: '',
    worktreeRemoved: false,
    removedBranches: [],
    logsRemoved: false,
    warnings: [],
  };
  if (!taskID) return result;

  const worktreePath = await findTaskWorktree(input.repoDir, taskID).catch(
    (error) => {
      result.warnings.push(
        `failed to locate worktree: ${toErrorMessage(error)}`,
      );
      return '';
    },
  );
  result.worktreePath = worktreePath;

  if (worktreePath) {
    const removed = await runGit(
      input.repoDir,
      ['worktree', 'remove', '--force', worktreePath],
      true,
    );
    if (removed.code === 0) {
      result.worktreeRemoved = true;
    } else {
      const message = removed.stderr || removed.stdout;
      if (!isMissingWorktreeError(message)) {
        result.warnings.push(
          `worktree remove failed for ${worktreePath}: ${message || 'unknown error'}`,
        );
      }
    }
  }

  const branches = await listTaskBranches(input.repoDir, taskID).catch(
    (error) => {
      result.warnings.push(`failed to list branches: ${toErrorMessage(error)}`);
      return [];
    },
  );
  for (const branch of branches) {
    const deleted = await runGit(input.repoDir, ['branch', '-D', branch], true);
    if (deleted.code === 0) {
      result.removedBranches.push(branch);
      continue;
    }
    const message = deleted.stderr || deleted.stdout;
    if (!isMissingBranchError(message)) {
      result.warnings.push(
        `branch delete failed for ${branch}: ${message || 'unknown error'}`,
      );
    }
  }

  if (input.removeLogs) {
    try {
      await input.removeLogs();
      result.logsRemoved = true;
    } catch (error) {
      result.warnings.push(`log cleanup failed: ${toErrorMessage(error)}`);
    }
  }

  return result;
}

async function listTaskBranches(
  repoDir: string,
  taskID: string,
): Promise<string[]> {
  const output = await runGit(
    repoDir,
    [
      'for-each-ref',
      '--format=%(refname:short)',
      `refs/heads/orca/task-${taskID}*`,
    ],
    true,
  );
  if (output.code !== 0) return [];
  return output.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

async function runGit(
  repoDir: string,
  args: string[],
  allowFailure: boolean,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const result = await sharedGitRun(repoDir, args);
  const code = result.exitCode;
  const stdout = result.stdout;
  const stderr = result.stderr;
  if (!allowFailure && code !== 0) {
    throw new Error(stderr || stdout || `git ${args.join(' ')} failed`);
  }
  return { code, stdout, stderr };
}

function isMissingWorktreeError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('not a working tree') ||
    normalized.includes('does not exist') ||
    normalized.includes('cannot remove')
  );
}

function isMissingBranchError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('not found') || normalized.includes('unknown revision')
  );
}
