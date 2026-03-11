import { JOB_PRIORITIES } from '@orca/types';
import { inArray } from 'drizzle-orm';
import type { EventSink } from '../api/ws';
import type { OrcaDrizzleDB } from '../db/connection';
import { taskInteractions } from '../db/schema';
import { findTaskWorktree } from '../domain/worktree';
import type { JobQueue } from '../queue/queue';
import { gitRun } from '../shared/git';
import type { InteractionStore } from '../store/interactions';
import * as taskStore from '../store/tasks';

interface ResetOpts {
  taskId: string;
  interactionId: string;
  enqueue?: boolean;
}

interface ResetResult {
  taskId: string;
  resetToStep: string;
  commitSha?: string;
  status: string;
  enqueued: boolean;
}

interface ResetDeps {
  db: OrcaDrizzleDB;
  sink?: EventSink;
  interactionStore: InteractionStore;
  queue: JobQueue;
  repoDir: string;
}

export async function resetToStep(
  opts: ResetOpts,
  deps: ResetDeps,
): Promise<ResetResult> {
  const task = await taskStore.getTask(deps.db, opts.taskId).catch(() => null);
  if (!task) throw new Error(`task not found: ${opts.taskId}`);
  if (task.status === 'running') {
    throw new Error('cannot reset a running task — stop it first');
  }

  const interaction = await deps.interactionStore.get(opts.interactionId);
  if (!interaction) {
    throw new Error(`interaction not found: ${opts.interactionId}`);
  }
  if (interaction.taskId !== opts.taskId) {
    throw new Error('interaction does not belong to this task');
  }

  // Build the keep-set by walking the previousInteractionId chain from target backward.
  const all = await deps.interactionStore.list(opts.taskId);
  const byId = new Map(all.map((ix) => [ix.id, ix]));

  const keepIds = new Set<string>();
  let cursor: string | undefined = interaction.id;
  while (cursor) {
    keepIds.add(cursor);
    const ix = byId.get(cursor);
    cursor = ix?.previousInteractionId ?? undefined;
  }

  // Find commitSha: use target's or walk the keep chain for the most recent prior
  let targetSha: string | undefined = interaction.commitSha ?? undefined;
  if (!targetSha) {
    let walk: string | undefined =
      interaction.previousInteractionId ?? undefined;
    while (walk) {
      const ix = byId.get(walk);
      if (ix?.commitSha) {
        targetSha = ix.commitSha;
        break;
      }
      walk = ix?.previousInteractionId ?? undefined;
    }
  }

  // Delete everything NOT in the keep set
  const toDelete = all.filter((ix) => !keepIds.has(ix.id));
  if (toDelete.length > 0) {
    await deps.db.delete(taskInteractions).where(
      inArray(
        taskInteractions.id,
        toDelete.map((ix) => ix.id),
      ),
    );
  }

  // Revert git state if we have a sha
  const worktreePath = await findTaskWorktree(deps.repoDir, opts.taskId);
  if (targetSha && worktreePath) {
    await gitRun(worktreePath, ['checkout', targetSha, '--', '.']);
    const addResult = await gitRun(worktreePath, ['add', '-A']);
    if (addResult.exitCode !== 0) {
      throw new Error(`git add failed: ${addResult.stderr}`);
    }
    const commitResult = await gitRun(worktreePath, [
      'commit',
      '-m',
      `orca: reset to ${targetSha.slice(0, 8)}`,
      '--allow-empty',
    ]);
    if (
      commitResult.exitCode !== 0 &&
      !commitResult.stderr.includes('nothing to commit')
    ) {
      throw new Error(`git commit failed: ${commitResult.stderr}`);
    }
  }

  // Determine the next step to run after reset.
  // If interactions were deleted, the oldest deleted one is the step that needs re-running.
  // If nothing was deleted, keep the task's existing currentStep (already points to next step).
  const targetStepName = interaction.stepName ?? interaction.type;
  let stepName: string;
  if (toDelete.length > 0) {
    const oldestDeleted = toDelete[toDelete.length - 1]!;
    stepName = oldestDeleted.stepName ?? oldestDeleted.type;
  } else {
    stepName = task.currentStep ?? targetStepName;
  }

  await taskStore.updateTask(deps.db, deps.sink, opts.taskId, {
    currentStep: stepName,
    status: 'planned',
  });

  await deps.queue.cancelForTask(opts.taskId);

  let enqueued = false;
  if (opts.enqueue) {
    const priority =
      JOB_PRIORITIES[stepName as keyof typeof JOB_PRIORITIES] ??
      JOB_PRIORITIES.plan;
    await deps.queue.enqueue({
      type: stepName,
      taskId: opts.taskId,
      priority,
    });
    enqueued = true;
  }

  return {
    taskId: opts.taskId,
    resetToStep: stepName,
    commitSha: targetSha,
    status: 'planned',
    enqueued,
  };
}
