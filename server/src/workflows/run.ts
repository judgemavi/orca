import type { RunOptions, Executor } from '../executor/executor'
import type { TaskRunResult } from '../executor/task-runner'
import type { TaskStore } from '../store/tasks'
import { TaskStatus } from '../types'

export interface RunOpts {
  taskIds?: string[]
  toolOverride?: string
  modelOverride?: string
  context?: string
}

export type TaskResult = TaskRunResult

export class RunWorkflowError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404,
  ) {
    super(message)
    this.name = 'RunWorkflowError'
  }
}

export async function startTasks(executor: Executor, opts: RunOpts = {}): Promise<void> {
  const taskIDs = normalizeTaskIDs(opts.taskIds)
  if (taskIDs.length > 0) {
    await executor.runBatch(taskIDs, toRunOptions(opts))
  } else {
    await executor.runPendingTasks()
  }
}

export async function startTask(
  executor: Executor,
  taskID: string,
  opts: RunOpts = {},
): Promise<TaskResult> {
  const normalizedTaskID = taskID.trim()
  if (!normalizedTaskID) {
    throw new RunWorkflowError('task id required', 400)
  }
  return await executor.runTaskByID(normalizedTaskID, toRunOptions(opts))
}

export async function resumeTask(
  executor: Executor,
  taskStore: TaskStore,
  taskID: string,
  feedback = '',
  opts: RunOpts = {},
): Promise<TaskResult> {
  const normalizedTaskID = taskID.trim()
  if (!normalizedTaskID) {
    throw new RunWorkflowError('task id required', 400)
  }

  const task = await taskStore.get(normalizedTaskID)
  if (!task) {
    throw new RunWorkflowError('task not found', 404)
  }
  if (task.status !== TaskStatus.stopped) {
    throw new RunWorkflowError(
      `task ${normalizedTaskID} is "${task.status}", not "stopped"`,
      400,
    )
  }
  if (!task.sessionId?.trim()) {
    throw new RunWorkflowError(`task ${normalizedTaskID} cannot resume without sessionId`, 400)
  }

  return await executor.resumeTask(normalizedTaskID, feedback, toRunOptions(opts))
}

export async function stopTask(
  executor: Executor,
  taskStore: TaskStore,
  taskID: string,
): Promise<void> {
  const normalizedTaskID = taskID.trim()
  if (!normalizedTaskID) {
    throw new RunWorkflowError('task id required', 400)
  }

  const stopped = executor.stopTask(normalizedTaskID)
  if (!stopped) {
    throw new RunWorkflowError('task not running', 404)
  }

  try {
    await taskStore.updateStatus(normalizedTaskID, TaskStatus.stopped)
  } catch (error) {
    const message = String(error)
    if (message.includes('not found')) {
      throw new RunWorkflowError('task not found', 404)
    }
    throw error
  }
}

function normalizeTaskIDs(taskIDs: string[] | undefined): string[] {
  if (!Array.isArray(taskIDs) || taskIDs.length === 0) return []
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const taskID of taskIDs) {
    const value = String(taskID ?? '').trim()
    if (!value || seen.has(value)) continue
    seen.add(value)
    normalized.push(value)
  }
  return normalized
}

function toRunOptions(opts: RunOpts): RunOptions {
  return {
    toolOverride: opts.toolOverride ?? '',
    modelOverride: opts.modelOverride ?? '',
    context: opts.context ?? '',
  }
}
