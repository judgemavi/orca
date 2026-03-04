import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { queryKeys } from '../lib/queryKeys';

export function useQueueQuery(filter?: { status?: string; taskId?: string }) {
  return useQuery({
    queryKey: [...queryKeys.queue, filter ?? {}],
    queryFn: () => api.listQueue(filter),
    refetchInterval: 10_000,
  });
}

export function useQueueCounts() {
  return useQuery({
    queryKey: queryKeys.queueCounts,
    queryFn: () => api.getQueueCounts(),
    refetchInterval: 5_000,
  });
}

export function useCancelJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) => api.cancelQueueJob(jobId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.queue });
      void qc.invalidateQueries({ queryKey: queryKeys.queueCounts });
    },
  });
}

export function useDrainQueue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.drainQueue(),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.queue });
      void qc.invalidateQueries({ queryKey: queryKeys.queueCounts });
    },
  });
}
