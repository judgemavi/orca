import { TASK_STATUSES } from '@orca/types';
import type { EventSink } from '../api/ws';
import type { OrcaDrizzleDB } from '../db/connection';
import {
  type MergeResult,
  mergeTaskWithGit,
  mergeWithConflictResolution,
} from '../domain/integrator';
import {
  type PostMergeEventSink,
  triggerPostMergeHooks,
} from '../domain/post-merge';
import type { ToolPluginRegistry } from '../plugin/registry';
import type { JobQueue } from '../queue/queue';
import * as configStore from '../store/config';
import type { InteractionStore } from '../store/interactions';
import type { MemoryStore } from '../store/memory';
import * as taskStore from '../store/tasks';
import {
  resumeUnblockedTask,
  type WorkflowEngineDeps,
} from '../workflow/engine';
import type { WorkflowStore } from '../workflow/store';

interface MergeWorkflowDeps {
  repoDir: string;
  db: OrcaDrizzleDB;
  sink?: EventSink;
  interactions: InteractionStore;
  memoryStore: MemoryStore;
  registry?: ToolPluginRegistry;
  postMergeSink?: PostMergeEventSink;
  queue?: JobQueue;
  workflowStore?: WorkflowStore;
}

export async function mergeTask(
  taskID: string,
  deps: MergeWorkflowDeps,
): Promise<MergeResult> {
  const config = await configStore.loadConfig(deps.db);
  const baseDeps = {
    repoDir: deps.repoDir,
    integrationBranch: config.project.integrationBranch,
    db: deps.db,
  };

  const result = deps.registry
    ? await mergeWithConflictResolution(taskID, {
        ...baseDeps,
        config,
        registry: deps.registry,
        interactionStore: deps.interactions,
        logsDir: `${deps.repoDir}/.orca/logs`,
      })
    : await mergeTaskWithGit(taskID, baseDeps);

  if (result.status !== TASK_STATUSES.merged) {
    await taskStore.updateTask(deps.db, deps.sink, taskID, {
      status: 'failed',
    });
    return result;
  }

  // Don't syncTaskStatus here — the workflow engine will do it after
  // completeStepActor transitions the machine to its finish state.
  triggerPostMergeHooks(taskID, {
    repoDir: deps.repoDir,
    db: deps.db,
    sink: deps.postMergeSink,
    interactions: deps.interactions,
    memoryStore: deps.memoryStore,
    registry: deps.registry,
    queue: deps.queue,
  });

  if (deps.queue && deps.workflowStore) {
    const eDeps: WorkflowEngineDeps = {
      db: deps.db,
      sink: deps.sink,
      queue: deps.queue,
      workflowStore: deps.workflowStore,
    };
    const unblocked = await taskStore.getUnblockedDependents(deps.db, taskID);
    for (const task of unblocked) {
      await resumeUnblockedTask(task, eDeps);
    }
  }

  return result;
}
