import type { InteractionStore } from '../store/interactions'
import type { TaskStore } from '../store/tasks'
import type { JobQueue } from '../queue/queue'
import {
  InteractionStatus,
  Phase,
  TaskStatus,
} from '../types'

export interface RecoverySummary {
  interactionsFailed: number
  tasksStopped: number
  tasksFailed: number
}

export async function failInFlightForShutdown(
  taskStore: TaskStore,
  interactions: InteractionStore,
  log: (event: string, data?: Record<string, unknown>) => void = () => {},
): Promise<RecoverySummary> {
  let interactionsFailed = 0
  let tasksStopped = 0
  let tasksFailed = 0

  const runningInteractions = await interactions.listByStatus(InteractionStatus.running)
  for (const item of runningInteractions) {
    await interactions.finish(item.id, {
      status: InteractionStatus.failed,
      error: 'shutdown signal received',
    })
    interactionsFailed += 1

    if (item.taskId?.trim() && item.phase === Phase.run) {
      const task = await taskStore.get(item.taskId)
      if (task && task.status === TaskStatus.running) {
        const next = task.sessionId?.trim() ? TaskStatus.stopped : TaskStatus.failed
        await taskStore.updateStatus(task.id, next)
        if (next === TaskStatus.stopped) tasksStopped += 1
        else tasksFailed += 1
      }
    }

    log('shutdown.recovery.interaction.failed', {
      interactionId: item.id,
      taskId: item.taskId ?? '',
      phase: item.phase,
    })
  }

  const runningTasks = await taskStore.listByStatus(TaskStatus.running)
  for (const task of runningTasks) {
    const next = task.sessionId?.trim() ? TaskStatus.stopped : TaskStatus.failed
    await taskStore.updateStatus(task.id, next)
    if (next === TaskStatus.stopped) tasksStopped += 1
    else tasksFailed += 1
    log('shutdown.recovery.task.reset', {
      taskId: task.id,
      toStatus: next,
    })
  }

  const summary = {
    interactionsFailed: interactionsFailed,
    tasksStopped: tasksStopped,
    tasksFailed: tasksFailed,
  }
  if (interactionsFailed > 0 || tasksStopped > 0 || tasksFailed > 0) {
    log('shutdown.recovery.complete', summary)
  }
  return summary
}

export async function runStartupRecovery(
  taskStore: TaskStore,
  interactions: InteractionStore,
  log: (event: string, data?: Record<string, unknown>) => void = () => {},
  queue?: JobQueue,
): Promise<RecoverySummary> {
  let interactionsFailed = 0
  let tasksStopped = 0
  let tasksFailed = 0

  const runningInteractions = await interactions.listByStatus(InteractionStatus.running)
  for (const item of runningInteractions) {
    await interactions.finish(item.id, {
      status: InteractionStatus.failed,
      error: item.error?.trim() || 'unclean shutdown',
    })
    interactionsFailed += 1
    log('startup.recovery.interaction.failed', {
      interactionId: item.id,
      taskId: item.taskId ?? '',
      phase: item.phase,
    })
  }

  if (queue) {
    const requeued = await queue.requeueRunning()
    if (requeued > 0) {
      log('startup.recovery.jobs.requeued', { count: requeued })
    }
  } else {
    // Without queue: fall back to resetting task statuses directly
    const runningTasks = await taskStore.listByStatus(TaskStatus.running)
    for (const task of runningTasks) {
      const next = task.sessionId?.trim() ? TaskStatus.stopped : TaskStatus.failed
      await taskStore.updateStatus(task.id, next)

      if (next === TaskStatus.stopped) tasksStopped += 1
      else tasksFailed += 1

      log('startup.recovery.task.reset', {
        taskId: task.id,
        fromStatus: TaskStatus.running,
        toStatus: next,
        resumable: Boolean(task.sessionId?.trim()),
      })
    }
  }

  const summary = {
    interactionsFailed: interactionsFailed,
    tasksStopped: tasksStopped,
    tasksFailed: tasksFailed,
  }
  if (interactionsFailed > 0 || tasksStopped > 0 || tasksFailed > 0) {
    log('startup.recovery.complete', summary)
  }
  return summary
}
