import { INTERACTION_STATUSES, REVIEW_STATUSES } from '@orca/server/types';
import type { Interaction, InteractionStub, TaskReview } from '../../../types';
import { AIReviewResultCard } from './AIReviewResultCard';

type Props = {
  interaction: Interaction;
  runReviewInteractions: InteractionStub[];
  runReviews: TaskReview[];
  latestCompletedRunStartedAt?: string;
};

export function ReviewSection({
  interaction,
  runReviewInteractions,
  runReviews,
  latestCompletedRunStartedAt,
}: Props) {
  const showRunReviews =
    interaction.type === 'run' || interaction.type === 'revise';
  const showReviewInteraction = interaction.type === 'review';
  const latestCompletedRunStartedAtMS = latestCompletedRunStartedAt
    ? Date.parse(latestCompletedRunStartedAt)
    : NaN;
  const hasReviewCutoff = Number.isFinite(latestCompletedRunStartedAtMS);
  const visibleRunReviewInteractions = hasReviewCutoff
    ? runReviewInteractions.filter(
        (item) => Date.parse(item.startedAt) > latestCompletedRunStartedAtMS,
      )
    : runReviewInteractions;
  const visibleRunReviews = hasReviewCutoff
    ? runReviews.filter(
        (review) =>
          Date.parse(review.createdAt) > latestCompletedRunStartedAtMS,
      )
    : runReviews;

  if (!showRunReviews && !showReviewInteraction) return null;

  return (
    <>
      {showRunReviews && visibleRunReviewInteractions.length > 0 && (
        <div className="flex flex-col gap-2">
          {visibleRunReviewInteractions.map((reviewStub) => (
            <AIReviewResultCard
              key={reviewStub.id}
              stub={reviewStub}
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
        <AIReviewResultCard
          stub={{
            id: interaction.id,
            taskId: interaction.taskId,
            type: interaction.type,
            attempt: interaction.attempt,
            tool: interaction.tool,
            status: interaction.status,
            durationMs: interaction.durationMs,
            estimatedCost: interaction.estimatedCost,
            startedAt: interaction.startedAt,
            finishedAt: interaction.finishedAt,
          }}
        />
      )}
    </>
  );
}
