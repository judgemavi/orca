import type { QueryClient } from '@tanstack/react-query'
import type { WSEvent, Task, Config, Interaction } from '../types'

function readString(
  data: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = data[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function handleWSEvent(queryClient: QueryClient, event: WSEvent) {
  const { type, data } = event

  // --- entity events: setQueryData ---

  if (type === 'task.created') {
    const task = data as unknown as Task
    queryClient.setQueryData<{ tasks: Task[] }>(['tasks'], (old) =>
      old ? { tasks: [...old.tasks, task] } : { tasks: [task] },
    )
    return
  }

  if (type === 'task.updated' || type === 'merge.completed') {
    const task = data as unknown as Task
    queryClient.setQueryData<{ tasks: Task[] }>(['tasks'], (old) =>
      old
        ? { tasks: old.tasks.map((t) => (t.id === task.id ? task : t)) }
        : old,
    )
    return
  }

  if (type === 'task.deleted') {
    const taskId = readString(data, 'id')
    if (taskId) {
      queryClient.setQueryData<{ tasks: Task[] }>(['tasks'], (old) =>
        old ? { tasks: old.tasks.filter((t) => t.id !== taskId) } : old,
      )
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
      queryClient.setQueryData<{ interactions: Interaction[] }>(
        ['task-interactions', taskId],
        (old) => {
          if (!old) return { interactions: [interaction] }
          const idx = old.interactions.findIndex(
            (i) => i.id === interaction.id,
          )
          if (idx >= 0) {
            const next = [...old.interactions]
            next[idx] = interaction
            return { interactions: next }
          }
          return { interactions: [...old.interactions, interaction] }
        },
      )
    }
    return
  }

  // --- signal-only events: invalidateQueries ---

  if (type.startsWith('ai-review.')) {
    const taskId = readString(data, 'task_id')
    if (taskId) {
      void queryClient.invalidateQueries({
        queryKey: ['task-interactions', taskId],
      })
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
      queryClient.invalidateQueries({ queryKey: ['tasks'] }),
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
      queryClient.invalidateQueries({ queryKey: ['tasks'] }),
      queryClient.invalidateQueries({ queryKey: ['operations'] }),
      queryClient.invalidateQueries({ queryKey: ['status'] }),
    ])
  }
}
