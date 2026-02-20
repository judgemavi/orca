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
  if (event.type.startsWith('task.')) {
    await queryClient.invalidateQueries({ queryKey: ['tasks'] })
    return
  }

  if (
    event.type === 'sprint.updated' ||
    event.type === 'sprint.planned' ||
    event.type === 'sprint.started' ||
    event.type === 'sprint.completed' ||
    event.type === 'sprint.failed' ||
    event.type === 'sprint.cancelled' ||
    event.type === 'sprint.reset'
  ) {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['tasks'] }),
      queryClient.invalidateQueries({ queryKey: ['sprints'] }),
      queryClient.invalidateQueries({ queryKey: ['sprint', 'active'] }),
      queryClient.invalidateQueries({ queryKey: ['operations'] }),
      queryClient.invalidateQueries({ queryKey: ['status'] }),
    ])
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

  if (event.type === 'review.completed') {
    const sprintId = readString(event.data, 'sprint_id')
    if (sprintId) {
      await queryClient.invalidateQueries({ queryKey: ['review', sprintId] })
    }
    return
  }

  if (
    event.type === 'decompose.started' ||
    event.type === 'decompose.completed' ||
    event.type === 'decompose.failed' ||
    event.type === 'merge.started' ||
    event.type === 'merge.completed' ||
    event.type === 'merge.failed' ||
    event.type === 'integrate.started' ||
    event.type === 'integrate.completed' ||
    event.type === 'integrate.failed' ||
    event.type === 'cleanup.started' ||
    event.type === 'cleanup.completed' ||
    event.type === 'cleanup.failed' ||
    event.type === 'explore.completed' ||
    event.type === 'explore.failed' ||
    event.type.startsWith('autopilot.')
  ) {
    await queryClient.invalidateQueries({ queryKey: ['operations'] })
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
