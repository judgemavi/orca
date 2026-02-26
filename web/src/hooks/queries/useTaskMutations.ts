import { useMutation } from '@tanstack/react-query'
import { api } from '../../api'

export function useApproveTaskMutation() {
  return useMutation({
    mutationFn: (taskId: string) => api.approveTask(taskId),
  })
}

export function useApprovePlanMutation() {
  return useMutation({
    mutationFn: (taskId: string) => api.approvePlan(taskId),
  })
}

export function useRequestChangesMutation() {
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
  })
}

export function useRequestPlanChangesMutation() {
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
  })
}

export function useRunTaskMutation() {
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
  })
}

export function useMergeTaskMutation() {
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
  })
}

export function useAIReviewMutation() {
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
