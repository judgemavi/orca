import * as Collapsible from '@radix-ui/react-collapsible'
import { useCallback, useEffect, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useMutation } from '@tanstack/react-query'
import { api } from '../../../api'
import { useTaskDetailContext } from '../../../context/TaskDetailContext'
import { useModelsQuery } from '../../../hooks/queries/useModels'
import {
  useSavePlanMutation,
  useTaskPlanQuery,
} from '../../../hooks/queries/usePlan'
import { useTaskReviewsQuery } from '../../../hooks/queries/useReviews'
import { useWebSocket } from '../../../hooks/useWebSocket'
import { controlClass } from '../../../lib/constants'
import { getErrorMessage } from '../../../lib/utils'
import {
  isKnownWSEvent,
  type Interaction,
  type TaskEvaluation,
} from '../../../types'
import { DiffViewer } from '../../blocks/DiffViewer'
import { ActionButton } from '../../common/ActionButton'
import { ToolModelSelector } from '../../common/ToolModelSelector'
import { AIReviewResultCard } from './AIReviewResultCard'
import { InteractionEntry } from './InteractionEntry'
import { useInteractionsQuery } from './useInteractions'

interface Props {
  taskId: string
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

type ParsedTaskEvaluation = {
  complexity?: string
  needs_breakdown: boolean
  confidence?: number
  reasoning: string
}

type RawTaskEvaluation = Partial<TaskEvaluation> & {
  should_decompose?: boolean
}

function parseTaskEvaluation(
  qualityJSON: string | undefined,
): ParsedTaskEvaluation | null {
  if (!qualityJSON) return null
  try {
    const parsed = JSON.parse(qualityJSON) as RawTaskEvaluation
    const needsBreakdown =
      typeof parsed.needs_breakdown === 'boolean'
        ? parsed.needs_breakdown
        : typeof parsed.should_decompose === 'boolean'
          ? parsed.should_decompose
          : null
    if (
      typeof needsBreakdown !== 'boolean' ||
      typeof parsed.reasoning !== 'string'
    ) {
      return null
    }
    return {
      complexity:
        typeof parsed.complexity === 'string' ? parsed.complexity : undefined,
      needs_breakdown: needsBreakdown,
      confidence:
        typeof parsed.confidence === 'number'
          ? parsed.confidence
          : undefined,
      reasoning: parsed.reasoning,
    }
  } catch {
    return null
  }
}

function confidencePercent(confidence: number | undefined): string {
  if (!Number.isFinite(confidence)) return '-'
  if ((confidence ?? 0) <= 1) return `${Math.round((confidence ?? 0) * 100)}`
  return `${Math.round(confidence ?? 0)}`
}

function evaluationComplexityLabel(evaluation: ParsedTaskEvaluation): string {
  if (evaluation.complexity?.trim()) return evaluation.complexity.trim()
  return evaluation.needs_breakdown ? 'high' : 'moderate'
}

export function TaskInteractionList({ taskId, readOnly = false }: Props) {
  const { task, tools, activeLogId, setActiveLogId, isOperationRunning } =
    useTaskDetailContext()
  const taskPlanQuery = useTaskPlanQuery(taskId)
  const savePlanMutation = useSavePlanMutation()
  const interactionsQuery = useInteractionsQuery(taskId, {
    select: (interactions) =>
      [...interactions].sort(
        (a, b) => Date.parse(a.started_at) - Date.parse(b.started_at),
      ),
  })
  const reviewsQuery = useTaskReviewsQuery(taskId)
  const mergeTaskMutation = useMutation({
    mutationFn: (args: {
      taskId: string
      mode?: string
      tool?: string
      model?: string
    }) => api.mergeTask(args.taskId, args.mode, args.tool, args.model),
  })

  const [expandedInteractions, setExpandedInteractions] = useState<Set<string>>(
    new Set(),
  )
  const [mergeTool, setMergeTool] = useState('')
  const [mergeModel, setMergeModel] = useState('')
  const [mergeProgress, setMergeProgress] = useState<string | null>(null)
  const [conflictError, setConflictError] = useState<string | null>(null)
  const [conflictWorktreePath, setConflictWorktreePath] = useState('')
  const [showManualResolve, setShowManualResolve] = useState(false)
  const [planDraft, setPlanDraft] = useState('')
  const [planEditing, setPlanEditing] = useState(true)
  const [planSaveError, setPlanSaveError] = useState<string | null>(null)

  const mergeModelsQuery = useModelsQuery(mergeTool || undefined)
  const interactions = interactionsQuery.data ?? []
  const runInteractions = useMemo(
    () => interactions.filter((item) => item.phase === 'run'),
    [interactions],
  )
  const reviewInteractions = useMemo(
    () => interactions.filter((item) => item.phase === 'review'),
    [interactions],
  )
  const mergeInteractions = useMemo(
    () => interactions.filter((item) => item.phase === 'merge'),
    [interactions],
  )
  const merging =
    isOperationRunning('merge', taskId) || mergeTaskMutation.isPending
  const mergeModels = mergeTool
    ? (mergeModelsQuery.data?.[mergeTool] ?? [])
    : []
  const mergeModelsFetching = mergeModelsQuery.isFetching

  const planInteractionIds = useMemo(
    () =>
      new Set(
        interactions
          .filter((item) => item.phase === 'plan')
          .map((item) => item.id),
      ),
    [interactions],
  )
  const runInteractionIDs = useMemo(
    () => new Set(runInteractions.map((item) => item.id)),
    [runInteractions],
  )
  const planReviews = useMemo(
    () =>
      (reviewsQuery.data?.reviews ?? []).filter(
        (review) =>
          Boolean(review.interaction_id) &&
          planInteractionIds.has(String(review.interaction_id)),
      ),
    [reviewsQuery.data?.reviews, planInteractionIds],
  )
  const runReviews = useMemo(
    () =>
      (reviewsQuery.data?.reviews ?? []).filter(
        (review) =>
          Boolean(review.interaction_id) &&
          runInteractionIDs.has(String(review.interaction_id)),
      ),
    [reviewsQuery.data?.reviews, runInteractionIDs],
  )

  const latestCompletedId =
    [...interactions].reverse().find((item) => item.status === 'completed')
      ?.id ?? null
  const latestCompletedPlanInteraction =
    [...interactions]
      .reverse()
      .find((item) => item.phase === 'plan' && item.status === 'completed') ??
    null
  const latestCompletedPlanId = latestCompletedPlanInteraction?.id ?? null
  const planEditableStatus =
    task.status === 'pending' || task.status === 'planned'
  const planEditable = !readOnly && planEditableStatus
  const currentPlanText =
    taskPlanQuery.data ??
    task.plan ??
    latestCompletedPlanInteraction?.diff ??
    ''
  const latestFailedMergeId =
    [...mergeInteractions]
      .reverse()
      .find((item) => item.status === 'failed')?.id ?? null
  const latestRunningMergeId =
    [...mergeInteractions]
      .reverse()
      .find((item) => item.status === 'running')?.id ?? null

  useEffect(() => {
    if (latestCompletedId) {
      setExpandedInteractions(new Set([latestCompletedId]))
      return
    }
    setExpandedInteractions(new Set())
  }, [latestCompletedId])

  useEffect(() => {
    if (!taskId) return
    setMergeProgress(null)
    setConflictError(null)
    setConflictWorktreePath('')
    setShowManualResolve(false)
    setMergeTool('')
    setMergeModel('')
    setPlanDraft('')
    setPlanEditing(true)
    setPlanSaveError(null)
  }, [taskId])

  useEffect(() => {
    if (task.status !== 'merged') return
    setMergeProgress(null)
    setConflictError(null)
    setConflictWorktreePath('')
    setShowManualResolve(false)
    setMergeTool('')
    setMergeModel('')
  }, [task.status])

  useEffect(() => {
    setPlanDraft(currentPlanText)
  }, [currentPlanText])

  useWebSocket(
    useCallback(
      (evt) => {
        if (!isKnownWSEvent(evt)) return

        let evtTaskId: string | undefined
        if (evt.type === 'merge.started' || evt.type === 'merge.failed') {
          evtTaskId = evt.data.task_id
        } else if (evt.type === 'merge.progress') {
          evtTaskId = evt.data.task_id
        } else if (evt.type === 'merge.completed') {
          evtTaskId = 'id' in evt.data ? evt.data.id : undefined
        } else if (evt.type === 'task.updated') {
          evtTaskId = evt.data.id
        }
        if (evtTaskId !== taskId) return

        if (evt.type === 'merge.started') {
          setMergeProgress('Merge started...')
          setConflictError(null)
          setConflictWorktreePath('')
          setShowManualResolve(false)
        } else if (evt.type === 'merge.progress') {
          setMergeProgress(evt.data.message ?? 'Resolving...')
        } else if (evt.type === 'merge.completed') {
          setMergeProgress(null)
          setConflictError(null)
        } else if (evt.type === 'merge.failed') {
          setMergeProgress(null)
          const isConflict = Boolean(evt.data.conflict)
          if (isConflict) {
            setConflictError(evt.data.error)
            setConflictWorktreePath(evt.data.worktree_path ?? '')
          } else {
            setConflictError(null)
            setConflictWorktreePath('')
          }
        } else if (evt.type === 'task.updated') {
          const status = 'status' in evt.data ? evt.data.status : ''
          if (
            status === 'merged' ||
            status === 'approved' ||
            status === 'failed'
          ) {
            setMergeProgress(null)
          }
        }
      },
      [taskId],
    ),
  )

  function toggleInteraction(id: string) {
    setExpandedInteractions((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const onToggleLog = (id: string) =>
    setActiveLogId(activeLogId === id ? null : id)

  const onSavePlan = async () => {
    setPlanSaveError(null)
    try {
      await savePlanMutation.mutateAsync({
        taskId,
        plan: planDraft,
      })
    } catch (err) {
      setPlanSaveError(getErrorMessage(err, 'Failed to save plan'))
    }
  }

  const onMergeToolChange = (t: string) => {
    setMergeTool(t)
    setMergeModel('')
  }
  const onMergeModelChange = setMergeModel

  const onAutoResolve = async () => {
    setMergeProgress('Auto-resolve queued...')
    try {
      await mergeTaskMutation.mutateAsync({
        taskId,
        mode: 'auto',
        tool: mergeTool || undefined,
        model: mergeModel || undefined,
      })
    } catch {
      setMergeProgress(null)
    }
  }

  const getReviewsForRun = useCallback(
    (runId: string, runStartedAt: string): Interaction[] => {
      const runIndex = runInteractions.findIndex((run) => run.id === runId)
      const nextRunStartedAt =
        runIndex < runInteractions.length - 1
          ? runInteractions[runIndex + 1].started_at
          : null

      return reviewInteractions.filter((reviewInteraction) => {
        const reviewStart = Date.parse(reviewInteraction.started_at)
        const runStart = Date.parse(runStartedAt)
        if (!Number.isFinite(reviewStart) || !Number.isFinite(runStart))
          return false
        if (reviewStart < runStart) return false
        if (nextRunStartedAt && reviewStart >= Date.parse(nextRunStartedAt))
          return false
        return true
      })
    },
    [runInteractions, reviewInteractions],
  )

  return (
    <div className="flex flex-col gap-4 rounded-lg bg-surface p-4">
      {interactionsQuery.isLoading && (
        <div className="text-xs">Loading interactions...</div>
      )}

      {!interactionsQuery.isLoading && interactions.length === 0 && (
        <div className="text-xs">No interactions yet.</div>
      )}

      {!interactionsQuery.isLoading && interactions.length > 0 && (
        <div className="flex flex-col gap-2">
          {interactions.map((item) => {
            const itemPlanReviews = planReviews.filter(
              (review) => review.interaction_id === item.id,
            )
            const itemRunReviews = runReviews.filter(
              (review) => review.interaction_id === item.id,
            )
            const runReviewInteractions =
              item.phase === 'run'
                ? getReviewsForRun(item.id, item.started_at)
                : []
            const isEditableLatestPlan =
              item.phase === 'plan' &&
              item.status === 'completed' &&
              item.id === latestCompletedPlanId &&
              planEditable

            return (
              <InteractionEntry
                key={item.id}
                interaction={item}
                phase={item.phase}
                collapsible
                showDiffSummary={item.phase === 'run'}
                expanded={
                  item.status === 'running' || expandedInteractions.has(item.id)
                }
                alwaysExpanded={item.status === 'running'}
                onExpandedChange={() => toggleInteraction(item.id)}
                activeLogId={activeLogId}
                onToggleLog={onToggleLog}
              >
                {isEditableLatestPlan && (
                  <div className="rounded-lg bg-surface p-3">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          className={[
                            'rounded border px-2 py-1 text-xs',
                            planEditing
                              ? 'border-accent bg-accent/10 text-accent'
                              : 'border-border-subtle',
                          ].join(' ')}
                          onClick={() => setPlanEditing(true)}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className={[
                            'rounded border px-2 py-1 text-xs',
                            !planEditing
                              ? 'border-accent bg-accent/10 text-accent'
                              : 'border-border-subtle',
                          ].join(' ')}
                          onClick={() => setPlanEditing(false)}
                        >
                          Preview
                        </button>
                      </div>
                      <ActionButton
                        variant="primary"
                        onClick={() => void onSavePlan()}
                        disabled={
                          savePlanMutation.isPending ||
                          planDraft === currentPlanText
                        }
                      >
                        {savePlanMutation.isPending ? 'Saving…' : 'Save Plan'}
                      </ActionButton>
                    </div>
                    {planEditing ? (
                      <textarea
                        value={planDraft}
                        onChange={(event) => setPlanDraft(event.target.value)}
                        className={`${controlClass} min-h-[220px] w-full resize-y font-mono text-xs leading-5`}
                      />
                    ) : (
                      <div className="prose prose-invert prose-sm max-h-[300px] max-w-none overflow-auto rounded-lg bg-surface-alt p-4 text-xs">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {planDraft}
                        </ReactMarkdown>
                      </div>
                    )}
                    {planSaveError && <div className="text-xs">{planSaveError}</div>}
                  </div>
                )}

                {!isEditableLatestPlan &&
                  item.phase === 'plan' &&
                  item.status === 'completed' &&
                  item.diff && (
                    <div className="prose prose-invert prose-sm max-h-[300px] max-w-none overflow-auto rounded-lg bg-surface p-4 text-xs">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {item.diff}
                      </ReactMarkdown>
                    </div>
                  )}

                {item.phase === 'plan' &&
                  item.status === 'completed' &&
                  itemPlanReviews.length > 0 && (
                    <div className="flex flex-col gap-2">
                      {itemPlanReviews.map((review) => (
                        <div
                          key={review.id}
                          className={[
                            'rounded-md border p-4',
                            review.status === 'pending'
                              ? 'border-amber-500/40 bg-amber-500/10'
                              : 'border-emerald-500/35 bg-emerald-500/10 opacity-80',
                          ].join(' ')}
                        >
                          <div className="mb-2 flex items-center justify-between gap-2">
                            <span className="text-xs font-medium uppercase tracking-wide">
                              {review.status}
                            </span>
                            <span className="text-xs">
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

                {item.phase === 'evaluate' &&
                  item.status === 'completed' &&
                  item.quality_json &&
                  (() => {
                    const evaluation = parseTaskEvaluation(item.quality_json)
                    if (!evaluation) return null
                    const requiresBreakdown = evaluation.needs_breakdown
                    return (
                      <div
                        className={[
                          'rounded-lg p-3',
                          requiresBreakdown
                            ? 'bg-amber-500/10 shadow-sm shadow-amber-500/10'
                            : 'bg-emerald-500/10 shadow-sm shadow-emerald-500/10',
                        ].join(' ')}
                      >
                        <div className="mb-2 flex flex-wrap items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.05em]">
                          <span>Evaluation</span>
                          <span
                            className={
                              requiresBreakdown
                                ? 'text-amber-400'
                                : 'text-emerald-400'
                            }
                          >
                            {requiresBreakdown
                              ? 'Breakdown Recommended'
                              : 'Ready To Plan'}
                          </span>
                        </div>
                        <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                          <span>
                            Complexity:{' '}
                            <span className="font-medium capitalize">
                              {evaluationComplexityLabel(evaluation)}
                            </span>
                          </span>
                          <span>
                            Confidence:{' '}
                            <span className="font-medium">
                              {confidencePercent(evaluation.confidence)}
                              {Number.isFinite(evaluation.confidence) ? '%' : ''}
                            </span>
                          </span>
                          <span>
                            Needs Breakdown:{' '}
                            <span className="font-medium">
                              {evaluation.needs_breakdown ? 'Yes' : 'No'}
                            </span>
                          </span>
                        </div>
                        <div className="whitespace-pre-wrap text-xs">
                          {evaluation.reasoning}
                        </div>
                      </div>
                    )
                  })()}

                {item.phase === 'run' && item.status === 'completed' && item.diff && (
                  <DiffViewer
                    data={{
                      task_id: task.id,
                      title: task.title,
                      diff: item.diff,
                      files_changed: [],
                      actions: [],
                    }}
                  />
                )}

                {item.phase === 'run' && runReviewInteractions.length > 0 && (
                  <div className="flex flex-col gap-2">
                    {runReviewInteractions.map((reviewInteraction) => (
                      <AIReviewResultCard
                        key={reviewInteraction.id}
                        interaction={reviewInteraction}
                        activeLogId={activeLogId}
                        onToggleLog={onToggleLog}
                      />
                    ))}
                  </div>
                )}

                {item.phase === 'run' &&
                  item.status === 'completed' &&
                  itemRunReviews.length > 0 && (
                    <div className="flex flex-col gap-2">
                      {itemRunReviews.map((review) => (
                        <div
                          key={review.id}
                          className={[
                            'rounded-md border p-4',
                            review.status === 'pending'
                              ? 'border-amber-500/40 bg-amber-500/10'
                              : 'border-emerald-500/35 bg-emerald-500/10',
                          ].join(' ')}
                        >
                          <div className="mb-2 flex items-center gap-2">
                            <span className="text-xs font-medium uppercase tracking-wide">
                              Request Changes
                            </span>
                            <span
                              className={[
                                'text-xs font-medium uppercase tracking-wide',
                                review.status === 'pending'
                                  ? 'text-amber-400'
                                  : 'text-emerald-400',
                              ].join(' ')}
                            >
                              {review.status === 'pending'
                                ? 'Pending'
                                : 'Addressed'}
                            </span>
                          </div>
                          <div className="whitespace-pre-wrap text-xs">
                            {review.feedback}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                {item.phase === 'review' && (
                  <AIReviewResultCard interaction={item} />
                )}

                {item.phase === 'merge' &&
                  item.id === latestRunningMergeId &&
                  item.status === 'running' &&
                  mergeProgress && (
                    <div className="rounded-lg bg-accent/10 p-4 text-xs leading-5 text-accent">
                      {mergeProgress}
                    </div>
                  )}

                {item.phase === 'merge' &&
                  item.id === latestFailedMergeId &&
                  item.status === 'failed' &&
                  conflictError && (
                    <div className="flex flex-col gap-2 rounded-lg bg-danger/10 p-4 text-danger">
                      <div className="text-xs leading-5">
                        Merge conflict: {conflictError}
                      </div>
                      {!readOnly && (
                        <div className="flex flex-col gap-2">
                          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto]">
                            <ToolModelSelector
                              tools={tools}
                              selectedTool={mergeTool}
                              selectedModel={mergeModel}
                              models={mergeModels}
                              modelsFetching={mergeModelsFetching}
                              onToolChange={onMergeToolChange}
                              onModelChange={onMergeModelChange}
                              controlClass={controlClass}
                              toolPlaceholder="- resolve tool"
                              modelPlaceholder="- default model"
                              className="contents"
                            />
                            <ActionButton
                              variant="primary"
                              onClick={() => void onAutoResolve()}
                              disabled={merging}
                            >
                              Auto-resolve
                            </ActionButton>
                          </div>
                          <Collapsible.Root
                            open={showManualResolve}
                            onOpenChange={setShowManualResolve}
                          >
                            <Collapsible.Trigger asChild>
                              <ActionButton variant="default">
                                Manual resolve
                              </ActionButton>
                            </Collapsible.Trigger>
                            <Collapsible.Content>
                              <div className="mt-2 flex flex-col gap-2 text-xs">
                                {conflictWorktreePath && (
                                  <div className="font-mono text-xs">
                                    Worktree: <code>{conflictWorktreePath}</code>
                                  </div>
                                )}
                                <div>
                                  Resolve conflicts in the worktree, commit the
                                  fixes, then click Retry Merge.
                                </div>
                              </div>
                            </Collapsible.Content>
                          </Collapsible.Root>
                        </div>
                      )}
                    </div>
                  )}
              </InteractionEntry>
            )
          })}
        </div>
      )}
    </div>
  )
}
