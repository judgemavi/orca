import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { api } from '../api';
import { queryKeys } from '../lib/queryKeys';
import type { ListMemoryParams, UpdateMemoryInput } from '../types';

// ── Tasks ───────────────────────────────────────────────────────────────

export function useTasksQuery() {
  return useQuery({
    queryKey: queryKeys.tasks,
    queryFn: () => api.listTasks(),
  });
}

export function useTaskQuery(taskId: string) {
  return useQuery({
    queryKey: queryKeys.task(taskId),
    queryFn: () => api.getTask(taskId),
  });
}

// ── Config ──────────────────────────────────────────────────────────────

export function useConfigQuery() {
  return useQuery({ queryKey: queryKeys.config, queryFn: api.getConfig });
}

export function useStatusQuery() {
  return useQuery({ queryKey: queryKeys.status, queryFn: api.getStatus });
}

// ── Models ──────────────────────────────────────────────────────────────

export function useModelsQuery(tool?: string) {
  return useQuery({
    queryKey: queryKeys.models(tool),
    queryFn: () => api.listModels(tool),
  });
}

// ── Operations ──────────────────────────────────────────────────────────

interface OperationsFilters {
  targetId?: string;
  type?: string;
}

function useOperationsQuery(filters?: OperationsFilters) {
  return useQuery({
    queryKey: queryKeys.operations(filters),
    queryFn: () => api.listOperations(filters),
  });
}

export function useRunningOperations() {
  const { data: operations } = useOperationsQuery();

  const runningOperations = useMemo(
    () => operations?.filter((op) => op.status === 'running'),
    [operations],
  );

  const isRunning = useCallback(
    (type: string, targetId?: string): boolean =>
      runningOperations?.some(
        (op) =>
          op.type === type &&
          (targetId === undefined ||
            targetId === '' ||
            op.targetId === targetId),
      ) ?? false,
    [runningOperations],
  );

  return { operations, isRunning };
}

// ── Reviews ─────────────────────────────────────────────────────────────

export function useTaskReviewsQuery(taskId: string) {
  return useQuery({
    queryKey: queryKeys.taskReviews(taskId),
    queryFn: () => api.getTaskReviews(taskId),
    enabled: Boolean(taskId),
  });
}

// ── Plan ────────────────────────────────────────────────────────────────

export function useTaskPlanQuery(taskId: string) {
  return useQuery({
    queryKey: queryKeys.taskPlan(taskId),
    queryFn: () => api.getTaskPlan(taskId),
    enabled: Boolean(taskId),
  });
}

export function useSavePlanMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, plan }: { taskId: string; plan: string }) =>
      api.saveTaskPlan(taskId, plan),
    onSuccess: async (_data, variables) => {
      queryClient.setQueryData(
        queryKeys.taskPlan(variables.taskId),
        variables.plan,
      );
      await queryClient.invalidateQueries({
        queryKey: queryKeys.taskPlan(variables.taskId),
      });
    },
  });
}

// ── Memory ───────────────────────────────────────────────────────────

export function useMemoryQuery(params?: ListMemoryParams) {
  return useQuery({
    queryKey: queryKeys.memoryList(params),
    queryFn: () => api.listMemory(params),
  });
}

export function useMemoryMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateMemoryInput }) =>
      api.updateMemory(id, data),
    onSuccess: async (entry) => {
      queryClient.removeQueries({
        queryKey: queryKeys.memoryEntry(entry.id),
        exact: true,
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.memory });
    },
  });
}

export function useDeleteMemoryMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteMemory(id),
    onSuccess: async (_result, id) => {
      queryClient.removeQueries({
        queryKey: queryKeys.memoryEntry(id),
        exact: true,
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.memory });
    },
  });
}

export function useSyncMemoryMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.syncMemory(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.memory });
      await queryClient.invalidateQueries({ queryKey: queryKeys.operations() });
      await queryClient.invalidateQueries({ queryKey: queryKeys.status });
    },
  });
}

export function useRefreshMemoryMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (entryId?: string) => api.refreshMemory(entryId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.memory });
      await queryClient.invalidateQueries({ queryKey: queryKeys.status });
    },
  });
}

export function useMemoryEntryQuery(id?: string) {
  return useQuery({
    queryKey: queryKeys.memoryEntry(id ?? ''),
    queryFn: () => api.getMemory(id ?? ''),
    enabled: Boolean(id),
  });
}

export function useMemorySemanticQuery(q: string, limit?: number) {
  return useQuery({
    queryKey: queryKeys.memoryQuery(q, limit),
    queryFn: () => api.queryMemory(q, limit),
    enabled: q.trim().length > 0,
  });
}
