import type { Interaction, TaskReview } from '../../../types'
import {
  INTERACTION_STATUSES,
  PHASES,
  REVIEW_STATUSES,
  isRunLike,
} from '../../../lib/phases'
import { AIReviewResultCard } from './AIReviewResultCard'

type Props = {
  interaction: Interaction
  runReviewInteractions: Interaction[]
  runReviews: TaskReview[]
  latestCompletedRunStartedAt?: string
}

export function ReviewPhaseSection({
  interaction,
  runReviewInteractions,
  runReviews,
  latestCompletedRunStartedAt,
}: Props) {
  const showRunReviews = isRunLike(interaction.phase)
  const showReviewInteraction = interaction.phase === PHASES.review
  const latestCompletedRunStartedAtMS = latestCompletedRunStartedAt
    ? Date.parse(latestCompletedRunStartedAt)
    : NaN
  const hasReviewCutoff = Number.isFinite(latestCompletedRunStartedAtMS)
  const visibleRunReviewInteractions = hasReviewCutoff
    ? runReviewInteractions.filter(
        (item) => Date.parse(item.started_at) > latestCompletedRunStartedAtMS,
      )
    : runReviewInteractions
  const visibleRunReviews = hasReviewCutoff
    ? runReviews.filter(
        (review) =>
          Date.parse(review.created_at) > latestCompletedRunStartedAtMS,
      )
    : runReviews

  if (!showRunReviews && !showReviewInteraction) return null

  return (
    <>
      {showRunReviews && visibleRunReviewInteractions.length > 0 && (
        <div className="flex flex-col gap-2">
          {visibleRunReviewInteractions.map((reviewInteraction) => (
            <AIReviewResultCard
              key={reviewInteraction.id}
              interaction={reviewInteraction}
              showLogButton
            />
          ))}
        </div>
      )}

      {showRunReviews &&
        interaction.status === INTERACTION_STATUSES.completed &&
        visibleRunReviews.length > 0 && (
          <div className="flex flex-col gap-2">
            {visibleRunReviews.map((review) => (
              <div
                key={review.id}
                className={[
                  'rounded-md border p-4',
                  review.status === REVIEW_STATUSES.pending
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
                      review.status === REVIEW_STATUSES.pending
                        ? 'text-amber-400'
                        : 'text-emerald-400',
                    ].join(' ')}
                  >
                    {review.status === REVIEW_STATUSES.pending
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

      {showReviewInteraction && (
        <AIReviewResultCard interaction={interaction} />
      )}
    </>
  )
}
