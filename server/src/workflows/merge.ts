import {
  type MergeResult,
  mergeApprovedTasksWithGit,
  mergeTaskWithGit,
  mergeWithConflictResolution,
} from '../domain/integrator';
import {
  type PostMergeEventSink,
  triggerPostMergeHooks,
} from '../domain/post-merge';
import type { ToolPluginRegistry } from '../plugin/registry';
import { unblockDependents } from '../queue/chain';
import type { JobQueue } from '../queue/queue';
import type { ConfigStore } from '../store/config';
import type { InteractionStore } from '../store/interactions';
import type { MemoryStore } from '../store/memory';
import type { TaskStore } from '../store/tasks';
import { TASK_STATUSES } from '../types';

export interface MergeWorkflowDeps {
  repoDir: string;
  taskStore: TaskStore;
  configStore: ConfigStore;
  interactions: InteractionStore;
  memoryStore: MemoryStore;
  registry?: ToolPluginRegistry;
  sink?: PostMergeEventSink;
  queue?: JobQueue;
}

export type BatchMergeResult = Awaited<
  ReturnType<typeof mergeApprovedTasksWithGit>
>;

export async function mergeTask(
  taskID: string,
  deps: MergeWorkflowDeps,
): Promise<MergeResult> {
  const config = await deps.configStore.load();
  const baseDeps = {
    repoDir: deps.repoDir,
    integrationBranch: config.project.integrationBranch,
    validationCommands: config.validation.commands,
    taskStore: deps.taskStore,
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
    await deps.taskStore.updateStatus(taskID, TASK_STATUSES.failed);
    return result;
  }

  await deps.taskStore.updateStatus(taskID, TASK_STATUSES.merged);
  triggerPostMergeHooks(taskID, {
    repoDir: deps.repoDir,
    taskStore: deps.taskStore,
    interactions: deps.interactions,
    memoryStore: deps.memoryStore,
    configStore: deps.configStore,
    registry: deps.registry,
    sink: deps.sink,
    queue: deps.queue,
  });

  if (deps.queue) {
    await unblockDependents(taskID, {
      configStore: deps.configStore,
      taskStore: deps.taskStore,
      queue: deps.queue,
    });
  }

  return result;
}

export async function mergeAllApproved(
  deps: MergeWorkflowDeps,
): Promise<BatchMergeResult> {
  const config = await deps.configStore.load();
  const result = await mergeApprovedTasksWithGit({
    repoDir: deps.repoDir,
    integrationBranch: config.project.integrationBranch,
    validationCommands: config.validation.commands,
    taskStore: deps.taskStore,
  });

  for (const id of result.merged) {
    await deps.taskStore.updateStatus(id, TASK_STATUSES.merged);
    triggerPostMergeHooks(id, {
      repoDir: deps.repoDir,
      taskStore: deps.taskStore,
      interactions: deps.interactions,
      memoryStore: deps.memoryStore,
      configStore: deps.configStore,
      registry: deps.registry,
      sink: deps.sink,
      queue: deps.queue,
    });
  }

  // Unblock dependents after all merges are done
  if (deps.queue) {
    for (const id of result.merged) {
      await unblockDependents(id, {
        configStore: deps.configStore,
        taskStore: deps.taskStore,
        queue: deps.queue,
      });
    }
  }

  for (const id of result.failed) {
    await deps.taskStore.updateStatus(id, TASK_STATUSES.failed);
  }

  return result;
}
