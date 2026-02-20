import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../api'

export const sprintsKeys = {
  all: ['sprints'] as const,
  list: (all?: boolean) => ['sprints', { all: Boolean(all) }] as const,
  active: ['sprint', 'active'] as const,
  detail: (id: string) => ['sprint', id] as const,
  review: (sprintId: string) => ['review', sprintId] as const,
}

export function useSprintsQuery(all?: boolean) {
  return useQuery({
    queryKey: sprintsKeys.list(all),
    queryFn: () => api.listSprints(all),
  })
}

export function useActiveSprintQuery() {
  return useQuery({
    queryKey: sprintsKeys.active,
    queryFn: () => api.getActiveSprint(),
  })
}

export function useSprintQuery(id: string) {
  return useQuery({
    queryKey: sprintsKeys.detail(id),
    queryFn: () => api.getSprint(id),
    enabled: Boolean(id),
  })
}

export function useReviewQuery(sprintId: string) {
  return useQuery({
    queryKey: sprintsKeys.review(sprintId),
    queryFn: () => api.getReview(sprintId),
    enabled: Boolean(sprintId),
  })
}

export function usePlanSprintMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => api.planSprint(),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: sprintsKeys.all }),
        queryClient.invalidateQueries({ queryKey: sprintsKeys.active }),
      ])
    },
  })
}

export function useStartSprintMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.startSprint(id),
    onSuccess: async (_data, sprintId) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: sprintsKeys.all }),
        queryClient.invalidateQueries({ queryKey: sprintsKeys.active }),
        queryClient.invalidateQueries({
          queryKey: sprintsKeys.detail(sprintId),
        }),
      ])
    },
  })
}

export function useCancelSprintMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.cancelSprint(id),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: sprintsKeys.all }),
        queryClient.invalidateQueries({ queryKey: sprintsKeys.active }),
      ])
    },
  })
}

export function useResetSprintMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.resetSprint(id),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: sprintsKeys.all }),
        queryClient.invalidateQueries({ queryKey: sprintsKeys.active }),
      ])
    },
  })
}

export function useAssignTaskToSprintMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ taskId, sprintId }: { taskId: string; sprintId?: string }) =>
      api.sprintAssign(taskId, sprintId),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['tasks'] }),
        queryClient.invalidateQueries({ queryKey: sprintsKeys.all }),
        queryClient.invalidateQueries({ queryKey: sprintsKeys.active }),
      ])
    },
  })
}

export function useUnassignTaskFromSprintMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (taskId: string) => api.sprintUnassign(taskId),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['tasks'] }),
        queryClient.invalidateQueries({ queryKey: sprintsKeys.all }),
        queryClient.invalidateQueries({ queryKey: sprintsKeys.active }),
      ])
    },
  })
}
