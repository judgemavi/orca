import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../../api'

export function useInteractionsQuery(taskId: string) {
  return useQuery({
    queryKey: ['task-interactions', taskId],
    queryFn: async () => {
      const data = await api.listInteractions(taskId)
      return data.interactions ?? []
    },
    enabled: Boolean(taskId),
    staleTime: 0,
    refetchOnMount: 'always',
  })
}

export function useInteractionContent(taskId: string, logId: string | null) {
  return useQuery({
    queryKey: ['task-interaction', taskId, logId],
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
