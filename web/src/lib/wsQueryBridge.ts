import type { QueryClient } from '@tanstack/react-query'
import type { WSEvent, Task, Config, Interaction } from '../types'
import { queryKeys } from './queryKeys'

type TasksCache = { tasks: Task[] }

function taskId(data: Record<string, unknown>): string | undefined {
  const v = data.task_id ?? data.id
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function upsertTask(qc: QueryClient, data: Record<string, unknown>) {
  const task = data as unknown as Task
  qc.setQueryData<TasksCache>(queryKeys.tasks, (old) => {
    const tasks = old?.tasks ?? []
    if (tasks.some((t) => t.id === task.id)) {
      return { tasks: tasks.map((t) => (t.id === task.id ? task : t)) }
    }
    return { tasks: [...tasks, task] }
  })
}

function upsertInteraction(qc: QueryClient, data: Record<string, unknown>) {
  const tid = taskId(data)
  if (!tid) return
  const interaction = data as unknown as Interaction
  qc.setQueryData<Interaction[]>(queryKeys.taskInteractions(tid), (old) => {
    const list = old ?? []
    const idx = list.findIndex((i) => i.id === interaction.id)
    if (idx >= 0) {
      const next = [...list]
      next[idx] = interaction
      return next
    }
    return [...list, interaction]
  })
}

const INVALIDATE_EXACT: Record<string, readonly (readonly string[])[]> = {
  'session.created': [queryKeys.sessions],
  'session.exited': [queryKeys.sessions],
  'plan.generating': [queryKeys.operations()],
  'plan.failed': [queryKeys.operations()],
  'merge.started': [queryKeys.operations(), queryKeys.status],
  'merge.progress': [queryKeys.operations(), queryKeys.status],
  'merge.failed': [queryKeys.operations(), queryKeys.status],
}

const SIGNAL_PREFIXES = ['run.', 'decompose.', 'cleanup.', 'explore.']

export function handleWSEvent(qc: QueryClient, event: WSEvent) {
  const { type, data } = event

  // --- entity events: setQueryData ---

  if (type === 'task.created' || type === 'task.updated' || type === 'merge.completed') {
    upsertTask(qc, data)
    return
  }

  if (type === 'task.deleted') {
    const id = taskId(data)
    if (id) {
      qc.setQueryData<TasksCache>(queryKeys.tasks, (old) => ({
        tasks: (old?.tasks ?? []).filter((t) => t.id !== id),
      }))
    }
    return
  }

  if (type === 'config.updated') {
    qc.setQueryData(queryKeys.config, data as unknown as Config)
    return
  }

  if (type === 'plan.completed') {
    const tid = taskId(data)
    if (tid) qc.setQueryData(queryKeys.taskPlan(tid), typeof data.plan === 'string' ? data.plan : '')
    return
  }

  if (type.startsWith('interaction.')) {
    upsertInteraction(qc, data)
    return
  }

  // --- signal events: invalidateQueries ---

  if (type.startsWith('ai-review.')) {
    const tid = taskId(data)
    if (tid) void qc.invalidateQueries({ queryKey: queryKeys.taskReviews(tid) })
    return
  }

  const exactKeys = INVALIDATE_EXACT[type]
  if (exactKeys) {
    void Promise.all(exactKeys.map((key) => qc.invalidateQueries({ queryKey: key })))
    return
  }

  if (SIGNAL_PREFIXES.some((p) => type.startsWith(p))) {
    void Promise.all([
      qc.invalidateQueries({ queryKey: queryKeys.operations() }),
      qc.invalidateQueries({ queryKey: queryKeys.status }),
    ])
  }
}
