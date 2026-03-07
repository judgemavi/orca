import { INTERACTION_STATUSES } from '@orca/server/types';
import { useMemo } from 'react';
import { useInteractionMetaQuery } from '../hooks/useInteractions';
import type { useMergeHandler } from '../hooks/useMergeHandler';
import type { usePlanEditor } from '../hooks/usePlanEditor';
import { useTaskActions } from '../hooks/useTaskActions';
import type { InteractionStub, Task, TaskReview } from '../types';
import { BreakdownSection } from './BreakdownSection';
import { EvaluateSection } from './EvaluateSection';
import { InteractionEntry } from './InteractionEntry';
import { MergeSection } from './MergeSection';
import { PlanSection } from './PlanSection';
import { RetroSection } from './RetroSection';
import { ReviewSection } from './ReviewSection';
import { RunSection } from './RunSection';

type Props = {
  stubs: InteractionStub[];
  reviews: TaskReview[];
  task: Task;
  tools: string[];
  readOnly: boolean;
  expandedInteractions: Set<string>;
  onToggleInteraction: (id: string) => void;
  planEditor: ReturnType<typeof usePlanEditor>;
  merge: ReturnType<typeof useMergeHandler>;
};

function InteractionContent({
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
  latestCompletedRunStartedAt,
  isLatestRunningMerge,
  isLatestFailedMerge,
  actions,
}: {
  taskId: string;
  stub: InteractionStub;
  expanded: boolean;
  task: Task;
  tools: string[];
  readOnly: boolean;
  planEditor: ReturnType<typeof usePlanEditor>;
  merge: ReturnType<typeof useMergeHandler>;
  planReviews: TaskReview[];
  runReviews: TaskReview[];
  latestCompletedRunStartedAt?: string;
  isLatestRunningMerge: boolean;
  isLatestFailedMerge: boolean;
  actions: ReturnType<typeof useTaskActions>;
}) {
  const metaQuery = useInteractionMetaQuery(taskId, stub.id, expanded);

  if (!expanded) return null;
  if (metaQuery.isLoading) {
    return (
      <div className="flex items-center gap-2 py-2 text-xs text-muted">
        <span className="inline-block h-3 w-16 animate-pulse rounded bg-surface" />
        Loading details...
      </div>
    );
  }

  const interaction = metaQuery.data;
  if (!interaction) return null;

  return (
    <>
      <PlanSection
        interaction={interaction}
        isEditableLatestPlan={
          stub.type === 'plan' &&
          stub.status === INTERACTION_STATUSES.completed &&
          stub.id === planEditor.latestCompletedPlanId &&
          planEditor.planEditable
        }
        planEditor={planEditor}
        planReviews={planReviews}
      />
      <EvaluateSection interaction={interaction} />
      <BreakdownSection
        interaction={interaction}
        proposals={actions.latestBreakdownProposals}
        onAccept={actions.handleAcceptBreakdown}
        onReject={actions.handleRejectBreakdown}
        accepting={actions.acceptBreakdownPending}
        rejecting={actions.rejectBreakdownPending}
      />
      <RunSection interaction={interaction} task={task} />
      <ReviewSection
        interaction={interaction}
        runReviews={runReviews}
        latestCompletedRunStartedAt={latestCompletedRunStartedAt}
      />
      <RetroSection interaction={interaction} />
      <MergeSection
        interaction={interaction}
        readOnly={readOnly}
        tools={tools}
        isLatestRunning={isLatestRunningMerge}
        isLatestFailed={isLatestFailedMerge}
        merge={merge}
      />
    </>
  );
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
  const actions = useTaskActions(task);
  const runStubs = useMemo(
    () =>
      stubs.filter((item) => item.type === 'code' || item.type === 'revise'),
    [stubs],
  );
  const mergeStubs = useMemo(
    () => stubs.filter((item) => item.type === 'merge'),
    [stubs],
  );

  const planStubIds = useMemo(
    () =>
      new Set(
        stubs.filter((item) => item.type === 'plan').map((item) => item.id),
      ),
    [stubs],
  );
  const runStubIDs = useMemo(
    () => new Set(runStubs.map((item) => item.id)),
    [runStubs],
  );

  const planReviews = useMemo(
    () =>
      reviews.filter(
        (review) =>
          Boolean(review.interactionId) &&
          planStubIds.has(String(review.interactionId)),
      ),
    [planStubIds, reviews],
  );
  const runReviews = useMemo(
    () =>
      reviews.filter(
        (review) =>
          Boolean(review.interactionId) &&
          runStubIDs.has(String(review.interactionId)),
      ),
    [reviews, runStubIDs],
  );

  const latestFailedMergeId =
    [...mergeStubs]
      .reverse()
      .find((item) => item.status === INTERACTION_STATUSES.failed)?.id ?? null;
  const latestRunningMergeId =
    [...mergeStubs]
      .reverse()
      .find((item) => item.status === INTERACTION_STATUSES.running)?.id ?? null;
  const latestCompletedRunStartedAt =
    runStubs.find((item) => item.status === INTERACTION_STATUSES.completed)
      ?.startedAt ?? null;
  const latestCompletedRunStartedAtMS = latestCompletedRunStartedAt
    ? Date.parse(latestCompletedRunStartedAt)
    : NaN;
  const hasReviewCutoff = Number.isFinite(latestCompletedRunStartedAtMS);

  const taskId = task.id;

  return (
    <div className="flex flex-col gap-2">
      {stubs.map((item) => {
        if (
          item.type === 'review' &&
          hasReviewCutoff &&
          Date.parse(item.startedAt) <= latestCompletedRunStartedAtMS
        ) {
          return null;
        }
        const isExpanded =
          item.status === INTERACTION_STATUSES.running ||
          expandedInteractions.has(item.id);
        return (
          <InteractionEntry
            key={item.id}
            stub={item}
            type={item.type}
            collapsible
            showDiffSummary={item.type === 'code' || item.type === 'revise'}
            expanded={isExpanded}
            alwaysExpanded={item.status === INTERACTION_STATUSES.running}
            onExpandedChange={() => onToggleInteraction(item.id)}
          >
            <InteractionContent
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
              latestCompletedRunStartedAt={
                latestCompletedRunStartedAt ?? undefined
              }
              isLatestRunningMerge={item.id === latestRunningMergeId}
              isLatestFailedMerge={item.id === latestFailedMergeId}
              actions={actions}
            />
          </InteractionEntry>
        );
      })}
    </div>
  );
}
