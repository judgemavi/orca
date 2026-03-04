import { isRunLike } from '@orca/types';
import { type UseQueryOptions, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '../../../api';
import { queryKeys } from '../../../lib/queryKeys';
import type { Interaction } from '../../../types';

type InteractionsQueryKey = ReturnType<typeof queryKeys.taskInteractions>;
type InteractionsSelect<TSelected> = Pick<
  UseQueryOptions<Interaction[], Error, TSelected, InteractionsQueryKey>,
  'select'
>;

export function selectByPhase(phase: string) {
  return (interactions: Interaction[]) =>
    [...interactions]
      .filter((i) => i.phase === phase)
      .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
}

export function selectByRunLike(interactions: Interaction[]) {
  return [...interactions]
    .filter((i) => isRunLike(i.phase))
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
}

export function useInteractionsQuery<TSelected = Interaction[]>(
  taskId: string,
  options?: InteractionsSelect<TSelected>,
) {
  return useQuery({
    queryKey: queryKeys.taskInteractions(taskId),
    queryFn: () => api.listInteractions(taskId),
    enabled: Boolean(taskId),
    staleTime: 0,
    refetchOnMount: 'always',
    ...options,
  });
}

export function useInteractionStubsQuery(taskId: string) {
  return useQuery({
    queryKey: queryKeys.interactionStubs(taskId),
    queryFn: () => api.listInteractionStubs(taskId),
    enabled: Boolean(taskId),
    staleTime: 0,
    refetchOnMount: 'always',
  });
}

export function useInteractionMetaQuery(
  taskId: string,
  id: string,
  enabled = true,
) {
  return useQuery({
    queryKey: queryKeys.interactionMeta(taskId, id),
    queryFn: () => api.getInteractionMeta(taskId, id),
    enabled: Boolean(taskId && id && enabled),
  });
}

export function useInteractionContent(taskId: string, logId: string | null) {
  return useQuery({
    queryKey: queryKeys.taskInteraction(taskId, String(logId)),
    queryFn: () => api.getInteraction(taskId, String(logId)),
    enabled: Boolean(taskId && logId),
  });
}

export function useInteractionStream(
  taskId: string,
  logId: string | null,
  enabled: boolean,
) {
  const [content, setContent] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);

  useEffect(() => {
    if (!enabled || !taskId || !logId) {
      setContent('');
      setIsStreaming(false);
      return;
    }

    setContent('');
    setIsStreaming(true);

    const eventSource = new EventSource(
      `/api/v1/tasks/${taskId}/interactions/${logId}/stream?raw=1`,
    );

    eventSource.onmessage = (event) => {
      setContent((prev) => prev + event.data);
    };

    eventSource.addEventListener('done', () => {
      setIsStreaming(false);
      eventSource.close();
    });

    eventSource.onerror = () => {
      setIsStreaming(false);
      eventSource.close();
    };

    return () => {
      setIsStreaming(false);
      eventSource.close();
    };
  }, [enabled, taskId, logId]);

  return { content, isStreaming };
}
