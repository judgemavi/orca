import type { DriverRegistry } from '../driver/registry'
import {
  mergeApprovedTasksWithGit,
  mergeTaskWithGit,
  mergeWithConflictResolution,
  type MergeResult,
} from '../domain/integrator'
import { triggerPostMergeHooks, type PostMergeEventSink } from '../domain/post-merge'
import type { ConfigStore } from '../store/config'
import type { InteractionStore } from '../store/interactions'
import type { MemoryStore } from '../store/memory'
import type { TaskStore } from '../store/tasks'
import { TaskStatus } from '../types'

export interface MergeWorkflowDeps {
  repoDir: string
  taskStore: TaskStore
  configStore: ConfigStore
  interactions: InteractionStore
  memoryStore: MemoryStore
  registry?: DriverRegistry
  sink?: PostMergeEventSink
}

export type BatchMergeResult = Awaited<ReturnType<typeof mergeApprovedTasksWithGit>>

export async function mergeTask(taskID: string, deps: MergeWorkflowDeps): Promise<MergeResult> {
  const config = await deps.configStore.load()
  const baseDeps = {
    repoDir: deps.repoDir,
    integrationBranch: config.project.integrationBranch,
    validationCommands: config.validation.commands,
    taskStore: deps.taskStore,
  }

  const result = deps.registry
    ? await mergeWithConflictResolution(taskID, {
        ...baseDeps,
        config,
        registry: deps.registry,
        interactionStore: deps.interactions,
        logsDir: `${deps.repoDir}/.orca/logs`,
      })
    : await mergeTaskWithGit(taskID, baseDeps)

  if (result.status !== TaskStatus.merged) {
    await deps.taskStore.updateStatus(taskID, TaskStatus.failed)
    return result
  }

  await deps.taskStore.updateStatus(taskID, TaskStatus.merged)
  triggerPostMergeHooks(taskID, {
    repoDir: deps.repoDir,
    taskStore: deps.taskStore,
    interactions: deps.interactions,
    memoryStore: deps.memoryStore,
    configStore: deps.configStore,
    registry: deps.registry,
    sink: deps.sink,
  })

  return result
}

export async function mergeAllApproved(deps: MergeWorkflowDeps): Promise<BatchMergeResult> {
  const config = await deps.configStore.load()
  const result = await mergeApprovedTasksWithGit({
    repoDir: deps.repoDir,
    integrationBranch: config.project.integrationBranch,
    validationCommands: config.validation.commands,
    taskStore: deps.taskStore,
  })

  for (const id of result.merged) {
    await deps.taskStore.updateStatus(id, TaskStatus.merged)
    triggerPostMergeHooks(id, {
      repoDir: deps.repoDir,
      taskStore: deps.taskStore,
      interactions: deps.interactions,
      memoryStore: deps.memoryStore,
      configStore: deps.configStore,
      registry: deps.registry,
      sink: deps.sink,
    })
  }

  for (const id of result.failed) {
    await deps.taskStore.updateStatus(id, TaskStatus.failed)
  }

  return result
}
