import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../api'
import { queryKeys } from '../../lib/queryKeys'

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
