import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../api'

export function useApproveTaskMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (taskId: string) => api.approveTask(taskId),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['tasks'] }),
        queryClient.invalidateQueries({ queryKey: ['operations'] }),
      ])
    },
  })
}

export function useApprovePlanMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (taskId: string) => api.approvePlan(taskId),
    onSuccess: async (_data, taskId) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['tasks'] }),
        queryClient.invalidateQueries({ queryKey: ['taskPlan', taskId] }),
      ])
    },
  })
}

export function useRequestChangesMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      id,
      feedback,
      interactionId,
      tool,
      model,
    }: {
      id: string
      feedback: string
      interactionId?: string
      tool?: string
      model?: string
    }) => api.requestChanges(id, feedback, interactionId, tool, model),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['tasks'] }),
        queryClient.invalidateQueries({ queryKey: ['operations'] }),
      ])
    },
  })
}

export function useRequestPlanChangesMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      id,
      feedback,
      interactionId,
      tool,
      model,
    }: {
      id: string
      feedback: string
      interactionId?: string
      tool?: string
      model?: string
    }) => api.requestPlanChanges(id, feedback, interactionId, tool, model),
    onSuccess: async (_data, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['tasks'] }),
        queryClient.invalidateQueries({
          queryKey: ['taskPlan', variables.id],
        }),
      ])
    },
  })
}

export function useRunTaskMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      taskId,
      tool,
      model,
    }: {
      taskId: string
      tool?: string
      model?: string
    }) => api.runTasks([taskId], tool, model),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['tasks'] }),
        queryClient.invalidateQueries({ queryKey: ['operations'] }),
      ])
    },
  })
}

export function useMergeTaskMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      taskId,
      mode,
      tool,
      model,
    }: {
      taskId: string
      mode?: string
      tool?: string
      model?: string
    }) => api.mergeTask(taskId, mode, tool, model),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['tasks'] }),
        queryClient.invalidateQueries({ queryKey: ['operations'] }),
      ])
    },
  })
}

export function useAIReviewMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      taskId,
      tool,
      model,
      prompt,
    }: {
      taskId: string
      tool?: string
      model?: string
      prompt?: string
    }) => api.aiReview(taskId, tool, model, prompt),
    onSuccess: async (_data, variables) => {
      await queryClient.invalidateQueries({
        queryKey: ['task-interactions', variables.taskId],
      })
    },
  })
}

export function useEvaluateTaskMutation() {
  return useMutation({
    mutationFn: ({
      taskId,
      tool,
      model,
    }: {
      taskId: string
      tool?: string
      model?: string
    }) => api.evaluateTask(taskId, tool, model),
  })
}
