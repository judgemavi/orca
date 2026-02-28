import { useCallback, useMemo } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api'
import { queryKeys } from '../lib/queryKeys'

// ── Tasks ───────────────────────────────────────────────────────────────

export function useTasksQuery() {
  return useQuery({
    queryKey: queryKeys.tasks,
    queryFn: () => api.listTasks(),
  })
}

export function useTaskQuery(taskId: string) {
  return useQuery({
    queryKey: queryKeys.task(taskId),
    queryFn: () => api.getTask(taskId),
  })
}

// ── Config ──────────────────────────────────────────────────────────────

export function useConfigQuery() {
  return useQuery({ queryKey: queryKeys.config, queryFn: api.getConfig })
}

// ── Models ──────────────────────────────────────────────────────────────

export function useModelsQuery(tool?: string) {
  return useQuery({
    queryKey: queryKeys.models(tool),
    queryFn: () => api.listModels(tool),
  })
}

// ── Operations ──────────────────────────────────────────────────────────

interface OperationsFilters {
  target_id?: string
  type?: string
}

export function useOperationsQuery(filters?: OperationsFilters) {
  return useQuery({
    queryKey: queryKeys.operations(filters),
    queryFn: () => api.listOperations(filters),
  })
}

export function useRunningOperations() {
  const { data: operations } = useOperationsQuery()

  const runningOperations = useMemo(
    () => operations?.filter((op) => op.status === 'running'),
    [operations],
  )

  const isRunning = useCallback(
    (type: string, targetId?: string): boolean =>
      runningOperations?.some(
        (op) =>
          op.type === type &&
          (targetId === undefined ||
            targetId === '' ||
            op.target_id === targetId),
      ) ?? false,
    [runningOperations],
  )

  return { operations, isRunning }
}

// ── Reviews ─────────────────────────────────────────────────────────────

export function useTaskReviewsQuery(taskId: string) {
  return useQuery({
    queryKey: queryKeys.taskReviews(taskId),
    queryFn: () => api.getTaskReviews(taskId),
    enabled: Boolean(taskId),
  })
}

// ── Plan ────────────────────────────────────────────────────────────────

export function useTaskPlanQuery(taskId: string) {
  return useQuery({
    queryKey: queryKeys.taskPlan(taskId),
    queryFn: () => api.getTaskPlan(taskId),
    enabled: Boolean(taskId),
  })
}

export function useSavePlanMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ taskId, plan }: { taskId: string; plan: string }) =>
      api.saveTaskPlan(taskId, plan),
    onSuccess: async (_data, variables) => {
      queryClient.setQueryData(
        queryKeys.taskPlan(variables.taskId),
        variables.plan,
      )
      await queryClient.invalidateQueries({
        queryKey: queryKeys.taskPlan(variables.taskId),
      })
    },
  })
}
