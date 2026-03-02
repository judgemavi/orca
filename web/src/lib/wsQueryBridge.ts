// Bridges WS events to react-query cache. Keeps UI in sync without polling.

import type { QueryClient, QueryKey } from '@tanstack/react-query'
import type { WSEvent, Task, Config, Interaction, KnownWSEvent } from '../types'
import { isKnownWSEvent } from '../types'
import { queryKeys } from './queryKeys'

type TasksCache = Task[]

const INVALIDATE_EXACT: Record<string, readonly QueryKey[]> = {
  'session.created': [queryKeys.sessions],
  'session.exited': [queryKeys.sessions],
  'plan.generating': [queryKeys.operations()],
  'plan.failed': [queryKeys.operations()],
  'merge.started': [queryKeys.operations(), queryKeys.status],
  'merge.progress': [queryKeys.operations(), queryKeys.status],
  'merge.failed': [queryKeys.operations(), queryKeys.status],
}

const SIGNAL_PREFIXES = [
  'run.',
  'breakdown.',
  'cleanup.',
  'explore.',
  'evaluate.',
]

function getTaskID(data: Record<string, unknown>): string | undefined {
  const taskID = data.task_id
  if (typeof taskID === 'string' && taskID.length > 0) return taskID

  const id = data.id
  if (typeof id === 'string' && id.length > 0) return id

  return undefined
}

function getTaskIDFromUnknown(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined
  return getTaskID(data as Record<string, unknown>)
}

function isTaskData(data: unknown): data is Task {
  if (!data || typeof data !== 'object') return false
  return 'id' in data && 'title' in data
}

function isInteractionData(data: unknown): data is Interaction {
  if (!data || typeof data !== 'object') return false
  return 'id' in data && 'phase' in data
}

function upsertTask(qc: QueryClient, task: Task) {
  qc.setQueryData<TasksCache>(queryKeys.tasks, (old) => {
    const tasks = old ?? []
    if (tasks.some((t) => t.id === task.id)) {
      return tasks.map((t) => (t.id === task.id ? task : t))
    }
    return [...tasks, task]
  })

  qc.setQueryData<Task>(queryKeys.task(task.id), task)
}

function upsertInteraction(qc: QueryClient, interaction: Interaction) {
  const tid = interaction.task_id
  if (!tid) return

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

function handleKnownEvent(qc: QueryClient, event: KnownWSEvent): boolean {
  switch (event.type) {
    case 'task.created':
      upsertTask(qc, event.data)
      return true

    case 'task.updated':
      if (isTaskData(event.data)) {
        upsertTask(qc, event.data)
      }
      return true

    case 'merge.completed':
      if (isTaskData(event.data)) {
        upsertTask(qc, event.data)
      }
      return true

    case 'task.deleted': {
      const id = event.data.id
      qc.setQueryData<TasksCache>(queryKeys.tasks, (old) =>
        (old ?? []).filter((t) => t.id !== id),
      )
      return true
    }

    case 'config.updated':
      qc.setQueryData<Config>(queryKeys.config, event.data)
      return true

    case 'plan.completed':
      qc.setQueryData(queryKeys.taskPlan(event.data.task_id), event.data.plan)
      void qc.invalidateQueries({
        queryKey: queryKeys.task(event.data.task_id),
      })
      return true

    case 'interaction.started':
    case 'interaction.updated':
    case 'interaction.completed':
    case 'interaction.failed':
      if (isInteractionData(event.data)) {
        upsertInteraction(qc, event.data)
      }
      return true

    case 'ai_review.failed':
    case 'ai_review.completed':
      void qc.invalidateQueries({
        queryKey: queryKeys.taskReviews(event.data.task_id),
      })
      return true

    default:
      return false
  }
}

export function handleWSEvent(qc: QueryClient, event: WSEvent) {
  if (isKnownWSEvent(event) && handleKnownEvent(qc, event)) {
    return
  }

  const exactKeys = INVALIDATE_EXACT[event.type]
  if (exactKeys) {
    void Promise.all(
      exactKeys.map((key) => qc.invalidateQueries({ queryKey: key })),
    )
    return
  }

  const data = event.data
  if (event.type.startsWith('ai_review.')) {
    const tid = getTaskIDFromUnknown(data)
    if (tid) void qc.invalidateQueries({ queryKey: queryKeys.taskReviews(tid) })
    return
  }

  if (event.type.startsWith('retro.')) {
    const tid = getTaskIDFromUnknown(event.data)
    const queries = [
      qc.invalidateQueries({ queryKey: queryKeys.operations() }),
      qc.invalidateQueries({ queryKey: queryKeys.status }),
    ]
    if (tid) {
      queries.push(
        qc.invalidateQueries({ queryKey: queryKeys.task(tid) }),
        qc.invalidateQueries({ queryKey: queryKeys.taskInteractions(tid) }),
      )
    }
    if (event.type === 'retro.completed') {
      queries.push(qc.invalidateQueries({ queryKey: queryKeys.memory }))
    }
    void Promise.all(queries)
    return
  }

  if (event.type.startsWith('memory.sync')) {
    void Promise.all([
      qc.invalidateQueries({ queryKey: queryKeys.memory }),
      qc.invalidateQueries({ queryKey: queryKeys.operations() }),
      qc.invalidateQueries({ queryKey: queryKeys.status }),
    ])
    return
  }

  if (SIGNAL_PREFIXES.some((p) => event.type.startsWith(p))) {
    void Promise.all([
      qc.invalidateQueries({ queryKey: queryKeys.operations() }),
      qc.invalidateQueries({ queryKey: queryKeys.status }),
    ])
  }
}
