import { useCallback } from 'react'
import type { QueryClient } from '@tanstack/react-query'
import { useQueryClient } from '@tanstack/react-query'
import type { WSEvent } from '../types'

function readString(
  data: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = data[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export async function invalidateQueriesForWSEvent(
  queryClient: QueryClient,
  event: WSEvent,
) {
  if (event.type === 'task.updated') {
    const taskId = readString(event.data, 'id')
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['tasks'] }),
      taskId
        ? queryClient.invalidateQueries({ queryKey: ['task', taskId] })
        : Promise.resolve(),
    ])
    return
  }

  if (event.type === 'task.deleted') {
    await queryClient.invalidateQueries({ queryKey: ['tasks'] })
    return
  }

  if (event.type.startsWith('task.')) {
    await queryClient.invalidateQueries({ queryKey: ['tasks'] })
    return
  }

  if (event.type === 'plan.completed') {
    const taskId = readString(event.data, 'task_id')
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['tasks'] }),
      taskId
        ? queryClient.invalidateQueries({ queryKey: ['taskPlan', taskId] })
        : Promise.resolve(),
    ])
    return
  }

  if (event.type.startsWith('interaction.')) {
    const taskId = readString(event.data, 'task_id')
    await Promise.all([
      taskId
        ? queryClient.invalidateQueries({ queryKey: ['task-interactions', taskId] })
        : Promise.resolve(),
      taskId
        ? queryClient.invalidateQueries({ queryKey: ['task-interaction', taskId] })
        : Promise.resolve(),
    ])
    return
  }

  if (event.type === 'session.created' || event.type === 'session.exited') {
    await queryClient.invalidateQueries({ queryKey: ['sessions'] })
    return
  }

  if (event.type === 'config.updated') {
    await queryClient.invalidateQueries({ queryKey: ['config'] })
    return
  }

  if (
    event.type === 'run.completed' ||
    event.type === 'run.failed' ||
    event.type === 'decompose.started' ||
    event.type === 'decompose.completed' ||
    event.type === 'decompose.failed' ||
    event.type === 'merge.started' ||
    event.type === 'merge.completed' ||
    event.type === 'merge.failed' ||
    event.type === 'cleanup.started' ||
    event.type === 'cleanup.completed' ||
    event.type === 'cleanup.failed' ||
    event.type === 'explore.completed' ||
    event.type === 'explore.failed'
  ) {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['tasks'] }),
      queryClient.invalidateQueries({ queryKey: ['operations'] }),
      queryClient.invalidateQueries({ queryKey: ['status'] }),
    ])
  }
}

export function useWSQueryBridge(onEvent?: (event: WSEvent) => void) {
  const queryClient = useQueryClient()

  return useCallback(
    (event: WSEvent) => {
      void invalidateQueriesForWSEvent(queryClient, event)
      onEvent?.(event)
    },
    [onEvent, queryClient],
  )
}
