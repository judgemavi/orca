import { BreakdownPhaseSection } from './BreakdownPhaseSection'
import { useCallback, useMemo } from 'react'
import { INTERACTION_STATUSES, PHASES, isRunLike } from '../../../lib/phases'
import type { Interaction, Task, TaskReview } from '../../../types'
import { EvaluatePhaseSection } from './EvaluatePhaseSection'
import { InteractionEntry } from './InteractionEntry'
import { MergePhaseSection } from './MergePhaseSection'
import { PlanPhaseSection } from './PlanPhaseSection'
import { ReviewPhaseSection } from './ReviewPhaseSection'
import { RunPhaseSection } from './RunPhaseSection'
import type { useMergeHandler } from './useMergeHandler'
import { useTaskActions } from './useTaskActions'
import type { usePlanEditor } from './usePlanEditor'

type Props = {
  interactions: Interaction[]
  reviews: TaskReview[]
  task: Task
  tools: string[]
  readOnly: boolean
  expandedInteractions: Set<string>
  onToggleInteraction: (id: string) => void
  planEditor: ReturnType<typeof usePlanEditor>
  merge: ReturnType<typeof useMergeHandler>
}

export function TaskInteractionItems({
  interactions,
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
  const runInteractions = useMemo(
    () => interactions.filter((item) => isRunLike(item.phase)),
    [interactions],
  )
  const reviewInteractions = useMemo(
    () => interactions.filter((item) => item.phase === PHASES.review),
    [interactions],
  )
  const mergeInteractions = useMemo(
    () => interactions.filter((item) => item.phase === PHASES.merge),
    [interactions],
  )

  const planInteractionIds = useMemo(
    () =>
      new Set(
        interactions
          .filter((item) => item.phase === PHASES.plan)
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
      reviews.filter(
        (review) =>
          Boolean(review.interaction_id) &&
          planInteractionIds.has(String(review.interaction_id)),
      ),
    [planInteractionIds, reviews],
  )
  const runReviews = useMemo(
    () =>
      reviews.filter(
        (review) =>
          Boolean(review.interaction_id) &&
          runInteractionIDs.has(String(review.interaction_id)),
      ),
    [reviews, runInteractionIDs],
  )

  const latestFailedMergeId =
    [...mergeInteractions]
      .reverse()
      .find((item) => item.status === INTERACTION_STATUSES.failed)?.id ?? null
  const latestRunningMergeId =
    [...mergeInteractions]
      .reverse()
      .find((item) => item.status === INTERACTION_STATUSES.running)?.id ?? null
  const latestCompletedRunStartedAt =
    runInteractions.find(
      (item) => item.status === INTERACTION_STATUSES.completed,
    )?.started_at ?? null
  const latestCompletedRunStartedAtMS = latestCompletedRunStartedAt
    ? Date.parse(latestCompletedRunStartedAt)
    : NaN
  const hasReviewCutoff = Number.isFinite(latestCompletedRunStartedAtMS)

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
    [reviewInteractions, runInteractions],
  )

  return (
    <div className="flex flex-col gap-2">
      {interactions.map((item) => {
        if (
          item.phase === PHASES.review &&
          hasReviewCutoff &&
          Date.parse(item.started_at) <= latestCompletedRunStartedAtMS
        ) {
          return null
        }
        return (
          <InteractionEntry
            key={item.id}
            interaction={item}
            phase={item.phase}
            collapsible
            showDiffSummary={isRunLike(item.phase)}
            expanded={
              item.status === INTERACTION_STATUSES.running ||
              expandedInteractions.has(item.id)
            }
            alwaysExpanded={item.status === INTERACTION_STATUSES.running}
            onExpandedChange={() => onToggleInteraction(item.id)}
          >
            <PlanPhaseSection
              interaction={item}
              isEditableLatestPlan={
                item.phase === PHASES.plan &&
                item.status === INTERACTION_STATUSES.completed &&
                item.id === planEditor.latestCompletedPlanId &&
                planEditor.planEditable
              }
              planEditor={planEditor}
              planReviews={planReviews.filter(
                (review) => review.interaction_id === item.id,
              )}
            />
            <EvaluatePhaseSection interaction={item} />
            <BreakdownPhaseSection
              interaction={item}
              proposals={actions.latestBreakdownProposals}
              onAccept={actions.handleAcceptBreakdown}
              onReject={actions.handleRejectBreakdown}
              accepting={actions.acceptBreakdownPending}
              rejecting={actions.rejectBreakdownPending}
            />
            <RunPhaseSection interaction={item} task={task} />
            <ReviewPhaseSection
              interaction={item}
              runReviewInteractions={
                isRunLike(item.phase)
                  ? getReviewsForRun(item.id, item.started_at)
                  : []
              }
              runReviews={runReviews.filter(
                (review) => review.interaction_id === item.id,
              )}
              latestCompletedRunStartedAt={
                latestCompletedRunStartedAt ?? undefined
              }
            />
            <MergePhaseSection
              interaction={item}
              readOnly={readOnly}
              tools={tools}
              isLatestRunning={item.id === latestRunningMergeId}
              isLatestFailed={item.id === latestFailedMergeId}
              merge={merge}
            />
          </InteractionEntry>
        )
      })}
    </div>
  )
}
