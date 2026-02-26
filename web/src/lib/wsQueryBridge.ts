import type { QueryClient } from '@tanstack/react-query'
import type { WSEvent, Task, Config, Interaction } from '../types'

function readString(
  data: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = data[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

type TasksCache = { tasks: Task[] }

function getTasks(old: TasksCache | undefined): Task[] {
  return old?.tasks ?? []
}

export function handleWSEvent(queryClient: QueryClient, event: WSEvent) {
  const { type, data } = event

  // --- entity events: setQueryData ---

  if (type === 'task.created') {
    const task = data as unknown as Task
    queryClient.setQueryData<TasksCache>(['tasks'], (old) => {
      const tasks = getTasks(old)
      if (tasks.some((t) => t.id === task.id)) {
        return { tasks: tasks.map((t) => (t.id === task.id ? task : t)) }
      }
      return { tasks: [...tasks, task] }
    })
    return
  }

  if (type === 'task.updated' || type === 'merge.completed') {
    const task = data as unknown as Task
    queryClient.setQueryData<TasksCache>(['tasks'], (old) => {
      const tasks = getTasks(old)
      return { tasks: tasks.map((t) => (t.id === task.id ? task : t)) }
    })
    return
  }

  if (type === 'task.deleted') {
    const taskId = readString(data, 'id')
    if (taskId) {
      queryClient.setQueryData<TasksCache>(['tasks'], (old) => {
        const tasks = getTasks(old)
        return { tasks: tasks.filter((t) => t.id !== taskId) }
      })
    }
    return
  }

  if (type === 'config.updated') {
    queryClient.setQueryData(['config'], data as unknown as Config)
    return
  }

  if (type === 'plan.completed') {
    const taskId = readString(data, 'task_id')
    const plan = typeof data.plan === 'string' ? data.plan : ''
    if (taskId) {
      queryClient.setQueryData(['taskPlan', taskId], plan)
    }
    return
  }

  if (type.startsWith('interaction.')) {
    const taskId = readString(data, 'task_id')
    if (taskId) {
      const interaction = data as unknown as Interaction
      queryClient.setQueryData<Interaction[]>(
        ['task-interactions', taskId],
        (old) => {
          const list = old ?? []
          const idx = list.findIndex((i) => i.id === interaction.id)
          if (idx >= 0) {
            const next = [...list]
            next[idx] = interaction
            return next
          }
          return [...list, interaction]
        },
      )
    }
    return
  }

  // --- signal-only events: invalidateQueries ---
  // Task cache is fully driven by task.created / task.updated / task.deleted
  // entity events above, so signal handlers only refresh non-entity queries
  // (operations, status, reviews, sessions).

  if (type.startsWith('ai-review.')) {
    const taskId = readString(data, 'task_id')
    if (taskId) {
      void queryClient.invalidateQueries({
        queryKey: ['task-reviews', taskId],
      })
    }
    return
  }

  if (type === 'session.created' || type === 'session.exited') {
    void queryClient.invalidateQueries({ queryKey: ['sessions'] })
    return
  }

  if (type === 'plan.generating' || type === 'plan.failed') {
    void queryClient.invalidateQueries({ queryKey: ['operations'] })
    return
  }

  if (
    type === 'merge.started' ||
    type === 'merge.progress' ||
    type === 'merge.failed'
  ) {
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: ['operations'] }),
      queryClient.invalidateQueries({ queryKey: ['status'] }),
    ])
    return
  }

  if (
    type.startsWith('run.') ||
    type.startsWith('decompose.') ||
    type.startsWith('cleanup.') ||
    type.startsWith('explore.')
  ) {
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: ['operations'] }),
      queryClient.invalidateQueries({ queryKey: ['status'] }),
    ])
  }
}
