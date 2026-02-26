import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../api'

const planKeys = {
  taskPlan: (taskId: string) => ['taskPlan', taskId] as const,
}

export function useTaskPlanQuery(taskId: string) {
  return useQuery({
    queryKey: planKeys.taskPlan(taskId),
    queryFn: () => api.getTaskPlan(taskId),
    enabled: Boolean(taskId),
  })
}

export function useGeneratePlanMutation() {
  return useMutation({
    mutationFn: ({
      taskId,
      tool,
      model,
    }: {
      taskId: string
      tool?: string
      model?: string
    }) => api.generateTaskPlan(taskId, { tool, model }),
  })
}

export function useSavePlanMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ taskId, plan }: { taskId: string; plan: string }) =>
      api.saveTaskPlan(taskId, plan),
    onSuccess: (_data, variables) => {
      queryClient.setQueryData(
        planKeys.taskPlan(variables.taskId),
        variables.plan,
      )
    },
  })
}
