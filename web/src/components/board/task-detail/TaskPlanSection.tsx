import * as Collapsible from '@radix-ui/react-collapsible'
import { useCallback, useEffect, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ActionButton } from '../../common/ActionButton'
import { ToolModelSelector } from '../../common/ToolModelSelector'
import { InteractionEntry } from './InteractionEntry'
import { useTaskDetailContext } from '../../../context/TaskDetailContext'
import { controlClass } from '../../../lib/constants'
import { useMutation } from '@tanstack/react-query'
import { api } from '../../../api'
import {
  useTaskPlanQuery,
  useSavePlanMutation,
} from '../../../hooks/queries/usePlan'
import { useModelsQuery } from '../../../hooks/queries/useModels'
import { useInteractionsQuery, selectByPhase } from './useInteractions'
import { useTaskReviewsQuery } from '../../../hooks/queries/useReviews'
import { useWebSocket } from '../../../hooks/useWebSocket'
import type { TaskEvaluation } from '../../../types'

interface Props {
  readOnly?: boolean
}

function formatRelativeTime(iso: string): string {
  const timestamp = Date.parse(iso)
  if (!Number.isFinite(timestamp)) return 'just now'
  const deltaSeconds = Math.round((timestamp - Date.now()) / 1000)
  const absDeltaSeconds = Math.abs(deltaSeconds)
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  if (absDeltaSeconds < 60) return rtf.format(deltaSeconds, 'second')
  if (absDeltaSeconds < 3600)
    return rtf.format(Math.round(deltaSeconds / 60), 'minute')
  if (absDeltaSeconds < 86400)
    return rtf.format(Math.round(deltaSeconds / 3600), 'hour')
  return rtf.format(Math.round(deltaSeconds / 86400), 'day')
}

export function TaskPlanSection({ readOnly = false }: Props) {
  const {
    task,
    tools,
    activeLogId,
    setActiveLogId,
    isOperationRunning,
  } = useTaskDetailContext()
  const taskPlanQuery = useTaskPlanQuery(task.id)
  const generatePlanMutation = useMutation({
    mutationFn: (args: { taskId: string; tool?: string; model?: string }) =>
      api.generateTaskPlan(args.taskId, { tool: args.tool, model: args.model }),
  })
  const savePlanMutation = useSavePlanMutation()
  const approvePlanMutation = useMutation({ mutationFn: (taskId: string) => api.approvePlan(taskId) })
  const requestPlanChangesMutation = useMutation({
    mutationFn: (args: { id: string; feedback: string; interactionId?: string; tool?: string; model?: string }) =>
      api.requestPlanChanges(args.id, args.feedback, args.interactionId, args.tool, args.model),
  })
  const evaluateTaskMutation = useMutation({
    mutationFn: (args: { taskId: string; tool?: string; model?: string }) =>
      api.evaluateTask(args.taskId, args.tool, args.model),
  })

  const [planDraft, setPlanDraft] = useState('')
  const [planEditing, setPlanEditing] = useState(false)
  const [planFeedback, setPlanFeedback] = useState('')
  const [planReviewExpanded, setPlanReviewExpanded] = useState(false)
  const [taskEvaluation, setTaskEvaluation] = useState<TaskEvaluation | null>(
    null,
  )
  const [generateTool, setGenerateTool] = useState('')
  const [generateModel, setGenerateModel] = useState('')
  const [planError, setPlanError] = useState<string | null>(null)
  const [expandedPlans, setExpandedPlans] = useState<Set<string>>(new Set())

  const generateModelsQuery = useModelsQuery(generateTool || undefined)
  const planInteractionsQuery = useInteractionsQuery(task.id, {
    select: selectByPhase('plan'),
  })
  const reviewsQuery = useTaskReviewsQuery(task.id)

  const planGenerating = isOperationRunning('plan_generate', task.id)
  const hasPlan = Boolean(taskPlanQuery.data?.trim())
  const planLoading = taskPlanQuery.isLoading
  const generatePlanPending = generatePlanMutation.isPending
  const evaluatingTask = evaluateTaskMutation.isPending
  const approvingPlan = approvePlanMutation.isPending
  const requestingPlanChanges = requestPlanChangesMutation.isPending
  const generateModelsFetching = generateModelsQuery.isFetching
  const generationModels = generateTool
    ? (generateModelsQuery.data?.[generateTool] ?? [])
    : []
  const planInteractions = planInteractionsQuery.data ?? []
  const planReviews = useMemo(() => {
    const reviews = reviewsQuery.data?.reviews ?? []
    const interactionIds = new Set(planInteractions.map((item) => item.id))
    return reviews.filter(
      (review) =>
        Boolean(review.interaction_id) &&
        interactionIds.has(String(review.interaction_id)),
    )
  }, [reviewsQuery.data?.reviews, planInteractions])

  useEffect(() => {
    setPlanDraft('')
    setPlanEditing(false)
    setPlanFeedback('')
    setPlanReviewExpanded(false)
    setTaskEvaluation(null)
    setGenerateTool('')
    setGenerateModel('')
    setPlanError(null)
    setExpandedPlans(new Set())
  }, [task.id])

  useEffect(() => {
    if (taskPlanQuery.data === undefined || planEditing) return
    setPlanDraft(taskPlanQuery.data)
  }, [taskPlanQuery.data, planEditing])

  useWebSocket(
    useCallback(
      (evt) => {
        const evtTaskId =
          (evt.data as any)?.task_id ?? (evt.data as any)?.id
        if (evtTaskId !== task.id) return
        if (evt.type === 'plan.failed') {
          setPlanError(
            String((evt.data as any)?.error ?? 'Failed to generate plan'),
          )
        }
      },
      [task.id],
    ),
  )

  const handleGeneratePlan = async () => {
    setPlanError(null)
    try {
      await generatePlanMutation.mutateAsync({
        taskId: task.id,
        tool: generateTool || undefined,
        model: generateModel || undefined,
      })
    } catch (err: any) {
      setPlanError(err?.message ?? 'Failed to generate plan')
    }
  }

  const handleApprovePlan = async () => {
    setPlanError(null)
    try {
      await approvePlanMutation.mutateAsync(task.id)
      setPlanReviewExpanded(false)
    } catch (err: any) {
      setPlanError(err?.message ?? 'Approve plan failed')
    }
  }

  const handleRequestPlanChanges = async (
    interactionId?: string,
    feedbackText?: string,
    tool?: string,
    model?: string,
  ) => {
    const trimmedFeedback = (feedbackText ?? planFeedback).trim()
    if (!trimmedFeedback) {
      setPlanError('Feedback is required')
      return
    }
    const trimmedInteractionID = (interactionId ?? '').trim()
    if (!trimmedInteractionID) {
      setPlanError('Interaction ID is required')
      return
    }

    setPlanError(null)
    try {
      await requestPlanChangesMutation.mutateAsync({
        id: task.id,
        feedback: trimmedFeedback,
        interactionId: trimmedInteractionID,
        tool: tool || generateTool || undefined,
        model: model || generateModel || undefined,
      })
      setPlanReviewExpanded(false)
      setPlanFeedback('')
    } catch (err: any) {
      setPlanError(err?.message ?? 'Request plan changes failed')
    }
  }

  const handleEvaluateTask = async () => {
    setPlanError(null)
    try {
      const response = await evaluateTaskMutation.mutateAsync({
        taskId: task.id,
        tool: generateTool || undefined,
        model: generateModel || undefined,
      })
      setTaskEvaluation(response.evaluation)
    } catch (err: any) {
      setPlanError(err?.message ?? 'Evaluate failed')
    }
  }

  const handleSavePlan = async () => {
    setPlanError(null)
    try {
      await savePlanMutation.mutateAsync({ taskId: task.id, plan: planDraft })
      setPlanEditing(false)
    } catch (err: any) {
      setPlanError(err?.message ?? 'Failed to save plan')
    }
  }

  void handleSavePlan

  const canGenerate = task.status === 'pending' && !hasPlan
  const canReviewPlan = task.status === 'pending' && hasPlan
  const hasRunningPlan = planInteractions.some(
    (item) => item.status === 'running',
  )
  const latestCompletedId =
    [...planInteractions].reverse().find((item) => item.status === 'completed')
      ?.id ?? null

  useEffect(() => {
    if (latestCompletedId) {
      setExpandedPlans(new Set([latestCompletedId]))
      return
    }
    setExpandedPlans(new Set())
  }, [latestCompletedId])

  function togglePlan(id: string) {
    setExpandedPlans((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  return (
    <div className="flex flex-col gap-2.5 rounded-md border p-3">
      {!readOnly && (
        <div
          className={[
            'grid grid-cols-1 items-center gap-2',
            canGenerate
              ? 'sm:grid-cols-[1fr_1fr_auto_auto]'
              : 'sm:grid-cols-[1fr_1fr_auto]',
          ].join(' ')}
        >
          <ToolModelSelector
            tools={tools}
            selectedTool={generateTool}
            selectedModel={generateModel}
            models={generationModels}
            modelsFetching={generateModelsFetching}
            onToolChange={setGenerateTool}
            onModelChange={setGenerateModel}
            controlClass={controlClass}
            modelPlaceholder="- default generation model"
            className="contents"
          />
          {canGenerate && (
            <ActionButton
              variant="primary"
              onClick={handleGeneratePlan}
              disabled={planGenerating || planLoading || generatePlanPending}
            >
              {planGenerating ? 'Generating…' : 'Generate Plan'}
            </ActionButton>
          )}
          <ActionButton
            variant="default"
            onClick={handleEvaluateTask}
            disabled={
              evaluatingTask ||
              planLoading ||
              planGenerating ||
              generatePlanPending
            }
          >
            {evaluatingTask ? 'Evaluating…' : 'Evaluate'}
          </ActionButton>
        </div>
      )}

      {taskEvaluation && (
        <div className="flex flex-col gap-1.5 rounded-md border p-2.5">
          <div className="text-xs">
            Complexity:{' '}
            <span className="font-medium">{taskEvaluation.complexity}</span>
          </div>
          <div className="text-xs">
            Should decompose:{' '}
            <span className="font-medium">
              {taskEvaluation.should_decompose ? 'Yes' : 'No'}
            </span>
          </div>
          <div className="text-xs">Reasoning</div>
          <div className="whitespace-pre-wrap text-xs">
            {taskEvaluation.reasoning}
          </div>
        </div>
      )}

      {planLoading && <div className="text-xs">Loading plan...</div>}
      {!planLoading && !hasPlan && planInteractions.length === 0 && (
        <div className="text-xs">No plan saved yet.</div>
      )}

      {!planLoading && hasPlan && planInteractions.length === 0 && (
        <div className="text-xs">No planning interactions yet.</div>
      )}

      {!planLoading && planInteractions.length > 0 && (
        <div className="flex flex-col gap-2">
          {planInteractions.map((item) => {
            const itemReviews = planReviews.filter(
              (review) => review.interaction_id === item.id,
            )
            const isLatestCompleted =
              item.status === 'completed' && item.id === latestCompletedId
            return (
              <InteractionEntry
                key={item.id}
                interaction={item}
                activeLogId={activeLogId}
                onToggleLog={(id) =>
                  setActiveLogId(activeLogId === id ? null : id)
                }
              >
                {item.status === 'completed' && item.diff && (
                  <Collapsible.Root
                    open={expandedPlans.has(item.id)}
                    onOpenChange={() => togglePlan(item.id)}
                  >
                    <Collapsible.Trigger asChild>
                      <button type="button" className="text-xs ">
                        {expandedPlans.has(item.id)
                          ? '▾ Hide plan'
                          : '▸ Show plan'}
                      </button>
                    </Collapsible.Trigger>
                    <Collapsible.Content>
                      <div className="prose prose-invert prose-sm max-w-none max-h-[300px] overflow-auto rounded-md border p-2.5 text-xs">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {item.diff}
                        </ReactMarkdown>
                      </div>
                    </Collapsible.Content>
                  </Collapsible.Root>
                )}

                {item.status === 'completed' && itemReviews.length > 0 && (
                  <div className="flex flex-col gap-1.5">
                    {itemReviews.map((review) => (
                      <div
                        key={review.id}
                        className={[
                          'rounded-md border p-2.5',
                          review.status === 'pending'
                            ? 'border-amber-500/40 bg-amber-500/10'
                            : 'border-emerald-500/35 bg-emerald-500/10 opacity-80',
                        ].join(' ')}
                      >
                        <div className="mb-1 flex items-center justify-between gap-2">
                          <span className="text-[10px] font-semibold uppercase tracking-[0.05em]">
                            {review.status}
                          </span>
                          <span className="text-[11px]">
                            {formatRelativeTime(review.created_at)}
                          </span>
                        </div>
                        <div className="whitespace-pre-wrap text-xs">
                          {review.feedback}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {isLatestCompleted &&
                  canReviewPlan &&
                  !readOnly &&
                  !hasRunningPlan && (
                    <div className="flex flex-col gap-2.5">
                      <div className="flex justify-end gap-2">
                        <ActionButton
                          variant="primary"
                          onClick={handleApprovePlan}
                          disabled={approvingPlan || requestingPlanChanges}
                        >
                          {approvingPlan ? 'Approving…' : 'Approve Plan'}
                        </ActionButton>
                        {!planReviewExpanded && (
                          <ActionButton
                            variant="default"
                            onClick={() => setPlanReviewExpanded(true)}
                            disabled={approvingPlan || requestingPlanChanges}
                          >
                            Request Changes
                          </ActionButton>
                        )}
                      </div>

                      {planReviewExpanded && (
                        <div className="flex flex-col gap-2.5 rounded-md border p-2.5">
                          <textarea
                            className="w-full resize-y rounded-md border p-2.5 text-xs outline-none focus:border-accent"
                            value={planFeedback}
                            onChange={(e) => setPlanFeedback(e.target.value)}
                            rows={4}
                            placeholder="Describe what should change in the plan..."
                          />
                          <div className="grid grid-cols-1 items-center gap-2 sm:grid-cols-[1fr_1fr]">
                            <ToolModelSelector
                              tools={tools}
                              selectedTool={generateTool}
                              selectedModel={generateModel}
                              models={generationModels}
                              modelsFetching={generateModelsFetching}
                              onToolChange={setGenerateTool}
                              onModelChange={setGenerateModel}
                              controlClass={controlClass}
                              modelPlaceholder="- default generation model"
                              className="contents"
                            />
                          </div>
                          <div className="flex justify-end gap-2">
                            <ActionButton
                              variant="default"
                              onClick={() => setPlanReviewExpanded(false)}
                              disabled={requestingPlanChanges}
                            >
                              Cancel
                            </ActionButton>
                            <ActionButton
                              variant="primary"
                              onClick={() =>
                                handleRequestPlanChanges(
                                  item.id,
                                  planFeedback,
                                  generateTool || undefined,
                                  generateModel || undefined,
                                )
                              }
                              disabled={
                                requestingPlanChanges ||
                                planGenerating ||
                                generatePlanPending
                              }
                            >
                              {requestingPlanChanges ? 'Submitting…' : 'Submit'}
                            </ActionButton>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
              </InteractionEntry>
            )
          })}
        </div>
      )}

      {planError && <div className="text-xs">{planError}</div>}
    </div>
  )
}
