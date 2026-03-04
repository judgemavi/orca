import { resolveModelForPhase, resolveToolForPhase } from '../config/config';
import { toolDefinition } from '../driver/registry';
import { loadPrompt } from '../prompts/loader';
import {
  formatRefLockContentionError,
  gitRun,
  gitRunWithRefLockRetry,
  isRefLockErrorResult,
} from '../shared/git';
import { INTERACTION_STATUSES, PHASES, TASK_STATUSES } from '../types';
import { runTool } from '../worker/worker';
import type {
  ConflictResolutionDeps,
  IntegratorDeps,
  MergeResult,
  MergeValidationResult,
} from './integrator';
import { findTaskWorktree } from './worktree';

const MAX_CONFLICT_ATTEMPTS = 10;

export interface ConflictResolutionRuntime {
  mergeTaskWithGitUnlocked: (
    taskID: string,
    deps: IntegratorDeps,
  ) => Promise<MergeResult>;
  resolveTaskBranch: (
    repoDir: string,
    taskID: string,
    worktreePath: string,
  ) => Promise<string>;
  runValidation: (
    repoDir: string,
    commands: string[],
  ) => Promise<MergeValidationResult>;
  rollbackMergedCommit: (repoDir: string) => Promise<string | undefined>;
  cleanupTaskWorktree: (
    repoDir: string,
    worktreePath: string,
    branch: string,
    taskID: string,
  ) => Promise<void>;
  gitRun: (
    cwd: string,
    args: string[],
    allowFailure?: boolean,
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
}

export async function mergeWithConflictResolutionUnlocked(
  taskID: string,
  deps: ConflictResolutionDeps,
  runtime: ConflictResolutionRuntime,
): Promise<MergeResult> {
  const basicResult = await runtime.mergeTaskWithGitUnlocked(taskID, deps);
  if (
    basicResult.status === TASK_STATUSES.merged ||
    basicResult.conflicts.length === 0
  ) {
    return basicResult;
  }

  const worktreePath = await findTaskWorktree(deps.repoDir, taskID);
  const branch = await runtime.resolveTaskBranch(
    deps.repoDir,
    taskID,
    worktreePath,
  );
  const base = deps.integrationBranch.trim();

  const failed = (
    message: string,
    opts?: Partial<MergeResult>,
  ): MergeResult => ({
    taskId: taskID,
    status: TASK_STATUSES.failed,
    branch,
    worktreePath: worktreePath,
    rebaseAttempted: true,
    conflicts: opts?.conflicts ?? basicResult.conflicts,
    validation: opts?.validation ?? { passed: false },
    error: message,
  });

  if (!worktreePath) {
    return failed('no worktree found for conflict resolution');
  }

  const toolName = resolveToolForPhase(deps.config, PHASES.merge, '');
  const driver = toolDefinition(deps.registry, toolName);
  if (!driver) {
    return failed(`merge tool not available: ${toolName}`);
  }
  const model = resolveModelForPhase(
    deps.config,
    deps.registry,
    PHASES.merge,
    toolName,
    '',
  );

  const interaction = await deps.interactionStore.begin({
    taskId: taskID,
    phase: PHASES.merge,
    tool: toolName,
  });

  try {
    const rebaseStart = await gitRunWithRefLockRetry(worktreePath, [
      'rebase',
      base,
    ]);
    if (rebaseStart.code === 0) {
      const checkoutBase = await gitRunWithRefLockRetry(deps.repoDir, [
        'checkout',
        base,
      ]);
      if (checkoutBase.code !== 0) {
        await runtime.gitRun(worktreePath, ['rebase', '--abort'], true);
        if (isRefLockErrorResult(checkoutBase)) {
          await deps.interactionStore.finish(interaction.id, {
            status: INTERACTION_STATUSES.failed,
            error: formatRefLockContentionError(checkoutBase.stderr),
            model,
          });
          return failed(formatRefLockContentionError(checkoutBase.stderr));
        }
        await deps.interactionStore.finish(interaction.id, {
          status: INTERACTION_STATUSES.failed,
          error: 'checkout integration branch failed after rebase',
          model,
        });
        return failed('checkout integration branch failed after rebase');
      }
      const finalMerge = await gitRunWithRefLockRetry(deps.repoDir, [
        'merge',
        branch,
        '--no-ff',
        '-m',
        `orca: merge task-${taskID} (after rebase)`,
      ]);
      if (finalMerge.code !== 0) {
        await runtime.gitRun(deps.repoDir, ['merge', '--abort'], true);
        if (isRefLockErrorResult(finalMerge)) {
          await deps.interactionStore.finish(interaction.id, {
            status: INTERACTION_STATUSES.failed,
            error: formatRefLockContentionError(finalMerge.stderr),
            model,
          });
          return failed(formatRefLockContentionError(finalMerge.stderr));
        }
        await deps.interactionStore.finish(interaction.id, {
          status: INTERACTION_STATUSES.failed,
          error: 'merge failed after clean rebase',
          model,
        });
        return failed('merge failed after clean rebase');
      }

      const validation = await runtime.runValidation(
        deps.repoDir,
        deps.validationCommands,
      );
      if (!validation.passed) {
        const rollbackError = await runtime.rollbackMergedCommit(deps.repoDir);
        await deps.interactionStore.finish(interaction.id, {
          status: INTERACTION_STATUSES.failed,
          error: `validation failed${validation.command ? ` (${validation.command})` : ''}`,
          model,
        });
        return failed(
          rollbackError
            ? `validation failed after clean rebase (rollback failed: ${rollbackError})`
            : 'validation failed after clean rebase',
          { validation },
        );
      }

      await runtime.cleanupTaskWorktree(
        deps.repoDir,
        worktreePath,
        branch,
        taskID,
      );
      await deps.interactionStore.finish(interaction.id, {
        status: INTERACTION_STATUSES.completed,
        model,
      });
      return {
        taskId: taskID,
        status: TASK_STATUSES.merged,
        branch,
        worktreePath: worktreePath,
        rebaseAttempted: true,
        conflicts: [],
        validation,
      };
    }

    if (isRefLockErrorResult(rebaseStart)) {
      await deps.interactionStore.finish(interaction.id, {
        status: INTERACTION_STATUSES.failed,
        error: formatRefLockContentionError(rebaseStart.stderr),
        model,
      });
      return failed(formatRefLockContentionError(rebaseStart.stderr));
    }

    const conflictPrompt = await loadPrompt(deps.repoDir, 'conflictResolve');

    for (let attempt = 0; attempt < MAX_CONFLICT_ATTEMPTS; attempt++) {
      const conflictFiles = await readConflictFiles(worktreePath);
      if (conflictFiles.length === 0) break;

      await runTool({
        taskID,
        driverName: toolName,
        driver,
        prompt: conflictPrompt,
        model,
        dir: worktreePath,
        cwd: worktreePath,
        logsDir: deps.logsDir,
        logPath: interaction.logPath,
        timeoutMS: 5 * 60_000,
      });

      await runtime.gitRun(worktreePath, ['add', '-A'], true);

      const cont = await gitRunWithRefLockRetry(worktreePath, [
        '-c',
        'core.editor=true',
        'rebase',
        '--continue',
      ]);
      if (cont.code === 0) break;
      if (isRefLockErrorResult(cont)) {
        await runtime.gitRun(worktreePath, ['rebase', '--abort'], true);
        await deps.interactionStore.finish(interaction.id, {
          status: INTERACTION_STATUSES.failed,
          error: formatRefLockContentionError(cont.stderr),
          model,
        });
        return failed(formatRefLockContentionError(cont.stderr));
      }

      const remaining = await readConflictFiles(worktreePath);
      if (remaining.length === 0) break;
    }

    const stillConflicting = await readConflictFiles(worktreePath);
    if (stillConflicting.length > 0) {
      await runtime.gitRun(worktreePath, ['rebase', '--abort'], true);
      await deps.interactionStore.finish(interaction.id, {
        status: INTERACTION_STATUSES.failed,
        error: `unresolved conflicts: ${stillConflicting.join(', ')}`,
        model,
      });
      return failed(
        `conflict resolution failed: ${stillConflicting.length} files unresolved`,
        {
          conflicts: stillConflicting,
        },
      );
    }

    const checkoutBase = await gitRunWithRefLockRetry(deps.repoDir, [
      'checkout',
      base,
    ]);
    if (checkoutBase.code !== 0) {
      if (isRefLockErrorResult(checkoutBase)) {
        await deps.interactionStore.finish(interaction.id, {
          status: INTERACTION_STATUSES.failed,
          error: formatRefLockContentionError(checkoutBase.stderr),
          model,
        });
        return failed(formatRefLockContentionError(checkoutBase.stderr));
      }
      await deps.interactionStore.finish(interaction.id, {
        status: INTERACTION_STATUSES.failed,
        error: 'checkout integration branch failed after conflict resolution',
        model,
      });
      return failed(
        'checkout integration branch failed after conflict resolution',
      );
    }

    const finalMerge = await gitRunWithRefLockRetry(deps.repoDir, [
      'merge',
      branch,
      '--no-ff',
      '-m',
      `orca: merge task-${taskID} (conflict-resolved)`,
    ]);
    if (finalMerge.code !== 0) {
      await runtime.gitRun(deps.repoDir, ['merge', '--abort'], true);
      if (isRefLockErrorResult(finalMerge)) {
        await deps.interactionStore.finish(interaction.id, {
          status: INTERACTION_STATUSES.failed,
          error: formatRefLockContentionError(finalMerge.stderr),
          model,
        });
        return failed(formatRefLockContentionError(finalMerge.stderr));
      }
      await deps.interactionStore.finish(interaction.id, {
        status: INTERACTION_STATUSES.failed,
        error: 'merge failed after conflict resolution',
        model,
      });
      return failed('merge failed after conflict resolution');
    }

    const validation = await runtime.runValidation(
      deps.repoDir,
      deps.validationCommands,
    );
    if (!validation.passed) {
      const rollbackError = await runtime.rollbackMergedCommit(deps.repoDir);
      await deps.interactionStore.finish(interaction.id, {
        status: INTERACTION_STATUSES.failed,
        error: `validation failed${validation.command ? ` (${validation.command})` : ''}`,
        model,
      });
      return failed(
        rollbackError
          ? `validation failed after conflict resolution (rollback failed: ${rollbackError})`
          : 'validation failed after conflict resolution',
        { validation },
      );
    }

    await runtime.cleanupTaskWorktree(
      deps.repoDir,
      worktreePath,
      branch,
      taskID,
    );
    await deps.interactionStore.finish(interaction.id, {
      status: INTERACTION_STATUSES.completed,
      model,
    });

    return {
      taskId: taskID,
      status: TASK_STATUSES.merged,
      branch,
      worktreePath: worktreePath,
      rebaseAttempted: true,
      conflicts: basicResult.conflicts,
      validation,
    };
  } catch (error) {
    await runtime
      .gitRun(worktreePath, ['rebase', '--abort'], true)
      .catch(() => {});
    const msg = error instanceof Error ? error.message : String(error);
    await deps.interactionStore.finish(interaction.id, {
      status: INTERACTION_STATUSES.failed,
      error: msg,
      model,
    });
    return failed(msg);
  }
}

export async function readConflictFiles(repoDir: string): Promise<string[]> {
  const result = await gitRun(repoDir, [
    'diff',
    '--name-only',
    '--diff-filter=U',
  ]);
  if (result.exitCode !== 0) return [];
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}
