import { BreakdownPhaseSection } from './BreakdownPhaseSection'
import { useCallback, useMemo } from 'react'
import { INTERACTION_STATUSES, PHASES, isRunLike } from '@orca/types'
import type { InteractionStub, Task, TaskReview } from '../../../types'
import { EvaluatePhaseSection } from './EvaluatePhaseSection'
import { InteractionEntry } from './InteractionEntry'
import { MergePhaseSection } from './MergePhaseSection'
import { PlanPhaseSection } from './PlanPhaseSection'
import { ReviewPhaseSection } from './ReviewPhaseSection'
import { RunPhaseSection } from './RunPhaseSection'
import type { useMergeHandler } from './useMergeHandler'
import { useTaskActions } from './useTaskActions'
import type { usePlanEditor } from './usePlanEditor'
import { useInteractionMetaQuery } from './useInteractions'

type Props = {
  stubs: InteractionStub[]
  reviews: TaskReview[]
  task: Task
  tools: string[]
  readOnly: boolean
  expandedInteractions: Set<string>
  onToggleInteraction: (id: string) => void
  planEditor: ReturnType<typeof usePlanEditor>
  merge: ReturnType<typeof useMergeHandler>
}

function PhaseContent({
  taskId,
  stub,
  expanded,
  task,
  tools,
  readOnly,
  planEditor,
  merge,
  planReviews,
  runReviews,
  runReviewStubs,
  latestCompletedRunStartedAt,
  isLatestRunningMerge,
  isLatestFailedMerge,
  actions,
}: {
  taskId: string
  stub: InteractionStub
  expanded: boolean
  task: Task
  tools: string[]
  readOnly: boolean
  planEditor: ReturnType<typeof usePlanEditor>
  merge: ReturnType<typeof useMergeHandler>
  planReviews: TaskReview[]
  runReviews: TaskReview[]
  runReviewStubs: InteractionStub[]
  latestCompletedRunStartedAt?: string
  isLatestRunningMerge: boolean
  isLatestFailedMerge: boolean
  actions: ReturnType<typeof useTaskActions>
}) {
  const metaQuery = useInteractionMetaQuery(taskId, stub.id, expanded)

  if (!expanded) return null
  if (metaQuery.isLoading) {
    return (
      <div className="flex items-center gap-2 py-2 text-xs text-muted">
        <span className="inline-block h-3 w-16 animate-pulse rounded bg-surface" />
        Loading details...
      </div>
    )
  }

  const interaction = metaQuery.data
  if (!interaction) return null

  return (
    <>
      <PlanPhaseSection
        interaction={interaction}
        isEditableLatestPlan={
          stub.phase === PHASES.plan &&
          stub.status === INTERACTION_STATUSES.completed &&
          stub.id === planEditor.latestCompletedPlanId &&
          planEditor.planEditable
        }
        planEditor={planEditor}
        planReviews={planReviews}
      />
      <EvaluatePhaseSection interaction={interaction} />
      <BreakdownPhaseSection
        interaction={interaction}
        proposals={actions.latestBreakdownProposals}
        onAccept={actions.handleAcceptBreakdown}
        onReject={actions.handleRejectBreakdown}
        accepting={actions.acceptBreakdownPending}
        rejecting={actions.rejectBreakdownPending}
      />
      <RunPhaseSection interaction={interaction} task={task} />
      <ReviewPhaseSection
        interaction={interaction}
        runReviewInteractions={
          isRunLike(stub.phase) ? runReviewStubs : []
        }
        runReviews={runReviews}
        latestCompletedRunStartedAt={latestCompletedRunStartedAt}
      />
      <MergePhaseSection
        interaction={interaction}
        readOnly={readOnly}
        tools={tools}
        isLatestRunning={isLatestRunningMerge}
        isLatestFailed={isLatestFailedMerge}
        merge={merge}
      />
    </>
  )
}

export function TaskInteractionItems({
  stubs,
  reviews,
  task,
  tools,
  readOnly,
  expandedInteractions,
  onToggleInteraction,
  planEditor,
  merge,
}: Props) {
  const actions = useTaskActions(task)
  const runStubs = useMemo(
    () => stubs.filter((item) => isRunLike(item.phase)),
    [stubs],
  )
  const reviewStubs = useMemo(
    () => stubs.filter((item) => item.phase === PHASES.review),
    [stubs],
  )
  const mergeStubs = useMemo(
    () => stubs.filter((item) => item.phase === PHASES.merge),
    [stubs],
  )

  const planStubIds = useMemo(
    () =>
      new Set(
        stubs
          .filter((item) => item.phase === PHASES.plan)
          .map((item) => item.id),
      ),
    [stubs],
  )
  const runStubIDs = useMemo(
    () => new Set(runStubs.map((item) => item.id)),
    [runStubs],
  )

  const planReviews = useMemo(
    () =>
      reviews.filter(
        (review) =>
          Boolean(review.interactionId) &&
          planStubIds.has(String(review.interactionId)),
      ),
    [planStubIds, reviews],
  )
  const runReviews = useMemo(
    () =>
      reviews.filter(
        (review) =>
          Boolean(review.interactionId) &&
          runStubIDs.has(String(review.interactionId)),
      ),
    [reviews, runStubIDs],
  )

  const latestFailedMergeId =
    [...mergeStubs]
      .reverse()
      .find((item) => item.status === INTERACTION_STATUSES.failed)?.id ?? null
  const latestRunningMergeId =
    [...mergeStubs]
      .reverse()
      .find((item) => item.status === INTERACTION_STATUSES.running)?.id ?? null
  const latestCompletedRunStartedAt =
    runStubs.find(
      (item) => item.status === INTERACTION_STATUSES.completed,
    )?.startedAt ?? null
  const latestCompletedRunStartedAtMS = latestCompletedRunStartedAt
    ? Date.parse(latestCompletedRunStartedAt)
    : NaN
  const hasReviewCutoff = Number.isFinite(latestCompletedRunStartedAtMS)

  const getReviewStubsForRun = useCallback(
    (runId: string, runStartedAt: string): InteractionStub[] => {
      const runIndex = runStubs.findIndex((run) => run.id === runId)
      const nextRunStartedAt =
        runIndex < runStubs.length - 1
          ? runStubs[runIndex + 1].startedAt
          : null

      return reviewStubs.filter((reviewStub) => {
        const reviewStart = Date.parse(reviewStub.startedAt)
        const runStart = Date.parse(runStartedAt)
        if (!Number.isFinite(reviewStart) || !Number.isFinite(runStart))
          return false
        if (reviewStart < runStart) return false
        if (nextRunStartedAt && reviewStart >= Date.parse(nextRunStartedAt))
          return false
        return true
      })
    },
    [reviewStubs, runStubs],
  )

  const taskId = task.id

  return (
    <div className="flex flex-col gap-2">
      {stubs.map((item) => {
        if (
          item.phase === PHASES.review &&
          hasReviewCutoff &&
          Date.parse(item.startedAt) <= latestCompletedRunStartedAtMS
        ) {
          return null
        }
        const isExpanded =
          item.status === INTERACTION_STATUSES.running ||
          expandedInteractions.has(item.id)
        return (
          <InteractionEntry
            key={item.id}
            stub={item}
            phase={item.phase}
            collapsible
            showDiffSummary={isRunLike(item.phase)}
            expanded={isExpanded}
            alwaysExpanded={item.status === INTERACTION_STATUSES.running}
            onExpandedChange={() => onToggleInteraction(item.id)}
          >
            <PhaseContent
              taskId={taskId}
              stub={item}
              expanded={isExpanded}
              task={task}
              tools={tools}
              readOnly={readOnly}
              planEditor={planEditor}
              merge={merge}
              planReviews={planReviews.filter(
                (review) => review.interactionId === item.id,
              )}
              runReviews={runReviews.filter(
                (review) => review.interactionId === item.id,
              )}
              runReviewStubs={
                isRunLike(item.phase)
                  ? getReviewStubsForRun(item.id, item.startedAt)
                  : []
              }
              latestCompletedRunStartedAt={
                latestCompletedRunStartedAt ?? undefined
              }
              isLatestRunningMerge={item.id === latestRunningMergeId}
              isLatestFailedMerge={item.id === latestFailedMergeId}
              actions={actions}
            />
          </InteractionEntry>
        )
      })}
    </div>
  )
}
