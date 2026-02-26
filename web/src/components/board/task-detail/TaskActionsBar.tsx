import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../api'
import { useTaskDetailContext } from '../../../context/TaskDetailContext'
import { useModelsQuery } from '../../../hooks/queries/useModels'
import { useTaskPlanQuery } from '../../../hooks/queries/usePlan'
import { useWebSocket } from '../../../hooks/useWebSocket'
import { controlClass } from '../../../lib/constants'
import { queryKeys } from '../../../lib/queryKeys'
import { getErrorMessage } from '../../../lib/utils'
import { isKnownWSEvent } from '../../../types'
import { ActionButton } from '../../common/ActionButton'
import { ToolModelSelector } from '../../common/ToolModelSelector'
import { selectByPhase, useInteractionsQuery } from './useInteractions'

interface Props {
  onClose: () => void
}

export function TaskActionsBar({
  onClose,
}: Props) {
  const queryClient = useQueryClient()
  const { task, tools, isOperationRunning } = useTaskDetailContext()
  const taskPlanQuery = useTaskPlanQuery(task.id)
  const planInteractionsQuery = useInteractionsQuery(task.id, {
    select: selectByPhase('plan'),
  })
  const runInteractionsQuery = useInteractionsQuery(task.id, {
    select: selectByPhase('run'),
  })
  const evaluateInteractionsQuery = useInteractionsQuery(task.id, {
    select: selectByPhase('evaluate'),
  })
  const reviewInteractionsQuery = useInteractionsQuery(task.id, {
    select: selectByPhase('review'),
  })
  const mergeInteractionsQuery = useInteractionsQuery(task.id, {
    select: selectByPhase('merge'),
  })

  const startTaskMutation = useMutation({
    mutationFn: (args: { taskId: string; tool?: string; model?: string }) =>
      api.startTasks([args.taskId], args.tool, args.model),
  })
  const approveMutation = useMutation({
    mutationFn: (taskId: string) => api.approveTask(taskId),
  })
  const stopTaskMutation = useMutation({
    mutationFn: (taskId: string) => api.stopTask(taskId),
  })
  const requestChangesMutation = useMutation({
    mutationFn: (args: {
      id: string
      feedback: string
      interactionId?: string
      tool?: string
      model?: string
    }) =>
      api.requestChanges(
        args.id,
        args.feedback,
        args.interactionId,
        args.tool,
        args.model,
      ),
  })
  const aiReviewMutation = useMutation({
    mutationFn: (args: {
      taskId: string
      tool?: string
      model?: string
      prompt?: string
    }) => api.aiReview(args.taskId, args.tool, args.model, args.prompt),
  })
  const mergeTaskMutation = useMutation({
    mutationFn: (args: { taskId: string; tool?: string; model?: string }) =>
      api.mergeTask(args.taskId, undefined, args.tool, args.model),
  })
  const resumeTaskMutation = useMutation({
    mutationFn: (taskId: string) => api.resumeTask(taskId),
  })
  const generateTaskPlanMutation = useMutation({
    mutationFn: (args: { taskId: string; tool?: string; model?: string }) =>
      api.generateTaskPlan(args.taskId, { tool: args.tool, model: args.model }),
  })
  const approvePlanMutation = useMutation({
    mutationFn: (taskId: string) => api.approvePlan(taskId),
  })
  const requestPlanChangesMutation = useMutation({
    mutationFn: (args: {
      id: string
      feedback: string
      interactionId?: string
      tool?: string
      model?: string
    }) =>
      api.requestPlanChanges(
        args.id,
        args.feedback,
        args.interactionId,
        args.tool,
        args.model,
      ),
  })
  const evaluateTaskMutation = useMutation({
    mutationFn: (args: { taskId: string; tool?: string; model?: string }) =>
      api.evaluateTask(args.taskId, args.tool, args.model),
  })

  const [requestChangesExpanded, setRequestChangesExpanded] = useState(false)
  const [requestFeedback, setRequestFeedback] = useState('')
  const [requestPlanChangesExpanded, setRequestPlanChangesExpanded] =
    useState(false)
  const [requestPlanFeedback, setRequestPlanFeedback] = useState('')
  const [aiReviewExpanded, setAIReviewExpanded] = useState(false)
  const [aiReviewPrompt, setAIReviewPrompt] = useState('')
  const [actionTool, setActionTool] = useState('')
  const [actionModel, setActionModel] = useState('')
  const [actionError, setActionError] = useState<string | null>(null)
  const [evaluateStarted, setEvaluateStarted] = useState(false)

  const actionModelsQuery = useModelsQuery(actionTool || undefined)
  const actionModels = actionTool
    ? (actionModelsQuery.data?.[actionTool] ?? [])
    : []
  const planInteractions = planInteractionsQuery.data ?? []
  const runInteractions = runInteractionsQuery.data ?? []
  const evaluateInteractions = evaluateInteractionsQuery.data ?? []
  const reviewInteractions = reviewInteractionsQuery.data ?? []
  const mergeInteractions = mergeInteractionsQuery.data ?? []
  const planLoading = taskPlanQuery.isLoading
  const planGenerating = isOperationRunning('plan_generate', task.id)
  const hasPlan = Boolean(taskPlanQuery.data?.trim())
  const evaluating =
    evaluateStarted ||
    evaluateInteractions.some((item) => item.status === 'running')

  const latestCompletedRunId = useMemo(
    () =>
      [...runInteractions].reverse().find((item) => item.status === 'completed')
        ?.id,
    [runInteractions],
  )
  const latestCompletedPlanId = useMemo(
    () =>
      [...planInteractions].reverse().find(
        (item) => item.status === 'completed',
      )?.id,
    [planInteractions],
  )

  const runningInProgress =
    task.status === 'running' || isOperationRunning('run', task.id)
  const runningBusy = runningInProgress || startTaskMutation.isPending
  const pendingPhaseInProgress =
    planInteractions.some((item) => item.status === 'running') ||
    evaluateInteractions.some((item) => item.status === 'running') ||
    planGenerating ||
    generateTaskPlanMutation.isPending ||
    isOperationRunning('evaluate', task.id) ||
    evaluateTaskMutation.isPending
  const reviewPhaseInProgress =
    reviewInteractions.some((item) => item.status === 'running') ||
    isOperationRunning('review', task.id) ||
    aiReviewMutation.isPending
  const approvedPhaseInProgress =
    mergeInteractions.some((item) => item.status === 'running') ||
    isOperationRunning('merge', task.id) ||
    mergeTaskMutation.isPending
  const phaseInProgress =
    task.status === 'pending'
      ? pendingPhaseInProgress
      : task.status === 'review'
        ? reviewPhaseInProgress
        : task.status === 'approved'
          ? approvedPhaseInProgress
          : false

  useEffect(() => {
    setRequestChangesExpanded(false)
    setRequestFeedback('')
    setRequestPlanChangesExpanded(false)
    setRequestPlanFeedback('')
    setAIReviewExpanded(false)
    setAIReviewPrompt('')
    setActionError(null)
    setEvaluateStarted(false)
  }, [task.id, task.status])

  useWebSocket((evt) => {
    if (!isKnownWSEvent(evt)) return
    if (evt.type === 'plan.failed' && evt.data.task_id === task.id) {
      setActionError(evt.data.error || 'Failed to generate plan')
      return
    }
    if (evt.type === 'evaluate.started' && evt.data.task_id === task.id) {
      setEvaluateStarted(true)
      return
    }
    if (evt.type === 'evaluate.completed' && evt.data.task_id === task.id) {
      setEvaluateStarted(false)
      setActionError(null)
      void queryClient.invalidateQueries({
        queryKey: queryKeys.taskInteractions(task.id),
      })
      return
    }
    if (evt.type === 'evaluate.failed' && evt.data.task_id === task.id) {
      setEvaluateStarted(false)
      setActionError(evt.data.error || 'Evaluate failed')
      void queryClient.invalidateQueries({
        queryKey: queryKeys.taskInteractions(task.id),
      })
    }
  })

  const handleStart = async () => {
    setActionError(null)
    try {
      await startTaskMutation.mutateAsync({
        taskId: task.id,
        tool: actionTool || undefined,
        model: actionModel || undefined,
      })
    } catch (err: unknown) {
      setActionError(getErrorMessage(err, 'Start failed'))
    }
  }

  const handleApprove = async () => {
    setActionError(null)
    try {
      await approveMutation.mutateAsync(task.id)
    } catch (err: unknown) {
      setActionError(getErrorMessage(err, 'Approve failed'))
    }
  }

  const refreshTaskState = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks }),
      queryClient.invalidateQueries({
        queryKey: queryKeys.taskInteractions(task.id),
      }),
      queryClient.invalidateQueries({ queryKey: queryKeys.operations() }),
    ])
  }

  const handleStop = async () => {
    setActionError(null)
    try {
      await stopTaskMutation.mutateAsync(task.id)
    } catch (err: unknown) {
      setActionError(getErrorMessage(err, 'Stop failed'))
      await refreshTaskState()
    }
  }

  const handleResume = async () => {
    setActionError(null)
    try {
      await resumeTaskMutation.mutateAsync(task.id)
    } catch (err: unknown) {
      setActionError(getErrorMessage(err, 'Resume failed'))
    }
  }

  const handleRequestChanges = async () => {
    const trimmedFeedback = requestFeedback.trim()
    if (!trimmedFeedback) {
      setActionError('Feedback is required')
      return
    }

    setActionError(null)
    try {
      await requestChangesMutation.mutateAsync({
        id: task.id,
        feedback: trimmedFeedback,
        interactionId: latestCompletedRunId,
        tool: actionTool || undefined,
        model: actionModel || undefined,
      })
      setRequestChangesExpanded(false)
      setRequestFeedback('')
    } catch (err: unknown) {
      setActionError(getErrorMessage(err, 'Request changes failed'))
    }
  }

  const handleGeneratePlan = async () => {
    setActionError(null)
    try {
      await generateTaskPlanMutation.mutateAsync({
        taskId: task.id,
        tool: actionTool || undefined,
        model: actionModel || undefined,
      })
    } catch (err: unknown) {
      setActionError(getErrorMessage(err, 'Failed to generate plan'))
    }
  }

  const handleApprovePlan = async () => {
    setActionError(null)
    try {
      await approvePlanMutation.mutateAsync(task.id)
      setRequestPlanChangesExpanded(false)
      setRequestPlanFeedback('')
    } catch (err: unknown) {
      setActionError(getErrorMessage(err, 'Approve plan failed'))
    }
  }

  const handleRequestPlanChanges = async () => {
    const trimmedFeedback = requestPlanFeedback.trim()
    if (!trimmedFeedback) {
      setActionError('Feedback is required')
      return
    }
    if (!latestCompletedPlanId) {
      setActionError('Interaction ID is required')
      return
    }

    setActionError(null)
    try {
      await requestPlanChangesMutation.mutateAsync({
        id: task.id,
        feedback: trimmedFeedback,
        interactionId: latestCompletedPlanId,
        tool: actionTool || undefined,
        model: actionModel || undefined,
      })
      setRequestPlanChangesExpanded(false)
      setRequestPlanFeedback('')
    } catch (err: unknown) {
      setActionError(getErrorMessage(err, 'Request plan changes failed'))
    }
  }

  const handleEvaluateTask = () => {
    setActionError(null)
    evaluateTaskMutation.mutate(
      {
        taskId: task.id,
        tool: actionTool || undefined,
        model: actionModel || undefined,
      },
      {
        onError: (err: unknown) => {
          setActionError(getErrorMessage(err, 'Evaluate failed'))
        },
      },
    )
  }

  const handleAIReview = async () => {
    setActionError(null)
    try {
      await aiReviewMutation.mutateAsync({
        taskId: task.id,
        tool: actionTool || undefined,
        model: actionModel || undefined,
        prompt: aiReviewPrompt.trim() || undefined,
      })
      setAIReviewExpanded(false)
      setAIReviewPrompt('')
    } catch (err: unknown) {
      setActionError(getErrorMessage(err, 'AI review failed'))
    }
  }

  const handleMerge = async () => {
    setActionError(null)
    try {
      await mergeTaskMutation.mutateAsync({
        taskId: task.id,
        tool: actionTool || undefined,
        model: actionModel || undefined,
      })
    } catch (err: unknown) {
      setActionError(getErrorMessage(err, 'Merge failed'))
    }
  }

  const renderStatusActions = () => {
    if (task.status === 'pending') {
      if (!hasPlan) {
        return (
          <>
            <ActionButton
              variant="primary"
              onClick={handleGeneratePlan}
              disabled={
                planLoading ||
                phaseInProgress ||
                evaluating
              }
            >
              {planGenerating || generateTaskPlanMutation.isPending
                ? 'Generating…'
                : 'Generate Plan'}
            </ActionButton>
            <ActionButton
              variant="default"
              onClick={handleEvaluateTask}
              disabled={
                planLoading ||
                phaseInProgress ||
                evaluating
              }
            >
              {evaluateTaskMutation.isPending || evaluating
                ? 'Evaluating…'
                : 'Evaluate'}
            </ActionButton>
          </>
        )
      }

      if (requestPlanChangesExpanded) {
        return (
          <>
            <ActionButton
              variant="default"
              onClick={() => {
                setRequestPlanChangesExpanded(false)
                setRequestPlanFeedback('')
                setActionError(null)
              }}
              disabled={phaseInProgress || requestPlanChangesMutation.isPending}
            >
              Cancel
            </ActionButton>
            <ActionButton
              variant="primary"
              onClick={handleRequestPlanChanges}
              disabled={
                phaseInProgress ||
                requestPlanChangesMutation.isPending ||
                approvePlanMutation.isPending
              }
            >
              {requestPlanChangesMutation.isPending
                ? 'Submitting…'
                : 'Submit Plan Changes'}
            </ActionButton>
          </>
        )
      }

      return (
        <>
          <ActionButton
            variant="primary"
            onClick={handleApprovePlan}
            disabled={
              phaseInProgress ||
              approvePlanMutation.isPending ||
              requestPlanChangesMutation.isPending
            }
          >
            {approvePlanMutation.isPending ? 'Approving…' : 'Approve Plan'}
          </ActionButton>
          <ActionButton
            variant="default"
            onClick={() => {
              setRequestPlanChangesExpanded(true)
              setAIReviewExpanded(false)
              setActionError(null)
            }}
            disabled={
              phaseInProgress ||
              approvePlanMutation.isPending ||
              requestPlanChangesMutation.isPending
            }
          >
            Request Plan Changes
          </ActionButton>
        </>
      )
    }

    if (task.status === 'planned') {
      return (
        <ActionButton
          variant="primary"
          onClick={handleStart}
          disabled={runningBusy}
        >
          {runningBusy ? 'Starting…' : 'Start'}
        </ActionButton>
      )
    }

    if (task.status === 'running') {
      return (
        <ActionButton
          variant="danger"
          onClick={handleStop}
          disabled={stopTaskMutation.isPending}
        >
          {stopTaskMutation.isPending ? (
            <>
              <span className="mr-1.5 inline-block h-3 w-3 animate-spin rounded-full border border-current border-t-transparent" />
              Stopping…
            </>
          ) : (
            'Stop'
          )}
        </ActionButton>
      )
    }

    if (task.status === 'stopped') {
      return (
        <>
          <ActionButton
            variant="primary"
            onClick={handleResume}
            disabled={runningBusy || resumeTaskMutation.isPending}
          >
            {runningBusy || resumeTaskMutation.isPending ? 'Resuming…' : 'Resume'}
          </ActionButton>
        </>
      )
    }

    if (task.status === 'review') {
      if (requestChangesExpanded) {
        return (
          <>
            <ActionButton
              variant="default"
              onClick={() => {
                setRequestChangesExpanded(false)
                setActionError(null)
              }}
              disabled={phaseInProgress || requestChangesMutation.isPending}
            >
              Cancel
            </ActionButton>
            <ActionButton
              variant="primary"
              onClick={handleRequestChanges}
              disabled={phaseInProgress || requestChangesMutation.isPending}
            >
              {requestChangesMutation.isPending
                ? 'Submitting…'
                : 'Submit Request Changes'}
            </ActionButton>
          </>
        )
      }

      if (aiReviewExpanded) {
        return (
          <>
            <ActionButton
              variant="default"
              onClick={() => {
                setAIReviewExpanded(false)
                setAIReviewPrompt('')
                setActionError(null)
              }}
              disabled={phaseInProgress}
            >
              Cancel
            </ActionButton>
            <ActionButton
              variant="primary"
              onClick={handleAIReview}
              disabled={phaseInProgress}
            >
              {aiReviewMutation.isPending ? 'Reviewing…' : 'Start Review'}
            </ActionButton>
          </>
        )
      }

      return (
        <>
          <ActionButton
            variant="primary"
            onClick={handleApprove}
            disabled={
              phaseInProgress ||
              approveMutation.isPending || requestChangesMutation.isPending
            }
          >
            {approveMutation.isPending ? 'Approving…' : 'Approve'}
          </ActionButton>
          <ActionButton
            variant="default"
            onClick={() => {
              setAIReviewExpanded(false)
              setRequestChangesExpanded(true)
              setActionError(null)
            }}
            disabled={
              phaseInProgress ||
              approveMutation.isPending || requestChangesMutation.isPending
            }
          >
            Request Changes
          </ActionButton>
          <ActionButton
            variant="default"
            onClick={() => {
              setRequestChangesExpanded(false)
              setAIReviewExpanded(true)
              setActionError(null)
            }}
            disabled={phaseInProgress || approveMutation.isPending}
          >
            {aiReviewMutation.isPending ? 'Reviewing…' : 'AI Review'}
          </ActionButton>
        </>
      )
    }

    if (task.status === 'approved') {
      return (
        <ActionButton
          variant="primary"
          onClick={handleMerge}
          disabled={phaseInProgress}
        >
          {phaseInProgress ? 'Merging…' : 'Merge'}
        </ActionButton>
      )
    }

    if (task.status === 'failed') {
      return (
        <ActionButton
          variant="primary"
          onClick={handleStart}
          disabled={runningBusy}
        >
          {runningBusy ? 'Re-running…' : 'Re-run'}
        </ActionButton>
      )
    }

    if (task.status === 'merged') {
      return (
        <ActionButton variant="default" onClick={onClose} type="button">
          Close
        </ActionButton>
      )
    }

    return null
  }

  const showToolModelSelector =
    task.status !== 'running' && task.status !== 'merged'

  return (
    <div className="sticky bottom-0 z-20 border-t border-border-subtle bg-surface-elevated/95 px-4 py-3 backdrop-blur-sm shadow-[0_-4px_12px_rgba(0,0,0,0.1)]">
      {(requestChangesExpanded || requestPlanChangesExpanded || aiReviewExpanded) && (
        <div className="mb-3 flex flex-col gap-2 rounded-lg border border-border-subtle bg-surface px-3 py-3">
          <textarea
            id="request-changes-feedback"
            className="w-full resize-y rounded-md border border-border-subtle bg-surface px-2.5 py-2 text-[13px] outline-none focus:border-accent"
            rows={3}
            value={
              requestPlanChangesExpanded
                ? requestPlanFeedback
                : aiReviewExpanded
                  ? aiReviewPrompt
                  : requestFeedback
            }
            onChange={(event) => {
              if (requestPlanChangesExpanded) {
                setRequestPlanFeedback(event.target.value)
                return
              }
              if (aiReviewExpanded) {
                setAIReviewPrompt(event.target.value)
                return
              }
              setRequestFeedback(event.target.value)
            }}
            placeholder={
              aiReviewExpanded
                ? 'Focus areas or instructions... (optional)'
                : 'Describe what needs to be changed...'
            }
          />
        </div>
      )}

      {actionError && <div className="mb-2 text-xs">{actionError}</div>}

      <div className="flex flex-wrap items-center justify-end gap-2">
        {showToolModelSelector && (
          <div className="mr-auto w-full min-w-[18rem] grow basis-full sm:basis-auto sm:max-w-[30rem]">
            <ToolModelSelector
              tools={tools}
              selectedTool={actionTool}
              selectedModel={actionModel}
              models={actionModels}
              modelsFetching={actionModelsQuery.isFetching}
              onToolChange={(tool) => {
                setActionTool(tool)
                setActionModel('')
              }}
              onModelChange={setActionModel}
              controlClass={controlClass}
              toolPlaceholder="- phase/default tool"
              modelPlaceholder="- default model"
              className="grid grid-cols-1 gap-2 sm:grid-cols-2"
            />
          </div>
        )}

        {renderStatusActions()}
      </div>
    </div>
  )
}
