import { useEffect, useState } from 'react'
import { useQuery, type UseQueryOptions } from '@tanstack/react-query'
import { api } from '../../../api'
import { queryKeys } from '../../../lib/queryKeys'
import type { Interaction } from '../../../types'

type InteractionsQueryKey = ReturnType<typeof queryKeys.taskInteractions>
type InteractionsSelect<TSelected> = Pick<
  UseQueryOptions<Interaction[], Error, TSelected, InteractionsQueryKey>,
  'select'
>

export function selectByPhase(phase: string) {
  return (interactions: Interaction[]) =>
    [...interactions]
      .filter((i) => i.phase === phase)
      .sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at))
}

export function useInteractionsQuery<TSelected = Interaction[]>(
  taskId: string,
  options?: InteractionsSelect<TSelected>,
) {
  return useQuery({
    queryKey: queryKeys.taskInteractions(taskId),
    queryFn: async () => {
      const data = await api.listInteractions(taskId)
      return data.interactions ?? []
    },
    enabled: Boolean(taskId),
    staleTime: 0,
    refetchOnMount: 'always',
    ...options,
  })
}

export function useInteractionContent(taskId: string, logId: string | null) {
  return useQuery({
    queryKey: queryKeys.taskInteraction(taskId, String(logId)),
    queryFn: () => api.getInteraction(taskId, String(logId)),
    enabled: Boolean(taskId && logId),
  })
}

export function useInteractionStream(
  taskId: string,
  logId: string | null,
  enabled: boolean,
) {
  const [content, setContent] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)

  useEffect(() => {
    if (!enabled || !taskId || !logId) {
      setContent('')
      setIsStreaming(false)
      return
    }

    setContent('')
    setIsStreaming(true)

    const eventSource = new EventSource(
      `/api/v1/tasks/${taskId}/interactions/${logId}/stream`,
    )

    eventSource.onmessage = (event) => {
      setContent((prev) => prev + event.data + '\n')
    }

    eventSource.addEventListener('done', () => {
      setIsStreaming(false)
      eventSource.close()
    })

    eventSource.onerror = () => {
      setIsStreaming(false)
      eventSource.close()
    }

    return () => {
      setIsStreaming(false)
      eventSource.close()
    }
  }, [enabled, taskId, logId])

  return { content, isStreaming }
}
