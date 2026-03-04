import { INTERACTION_STATUSES } from '@orca/types';
import { parseJSONText } from '../../../lib/orchestratorRichContent';
import type { AIReviewResult, InteractionStub } from '../../../types';
import { ReviewResultCard } from '../../shared/ReviewResultCard';
import { useInteractionDetailContext } from './InteractionDetailContext';
import { useInteractionMetaQuery } from './useInteractions';

interface Props {
  stub: InteractionStub;
  dismissed?: boolean;
  showLogButton?: boolean;
}

export function AIReviewResultCard({
  stub,
  dismissed,
  showLogButton = false,
}: Props) {
  const detailContext = useInteractionDetailContext();
  const activeLogId = detailContext?.activeLogId ?? null;
  const onToggleLog = detailContext?.onToggleLog;
  const needsFull =
    stub.status === INTERACTION_STATUSES.completed ||
    stub.status === INTERACTION_STATUSES.failed;
  const metaQuery = useInteractionMetaQuery(
    stub.taskId ?? '',
    stub.id,
    needsFull,
  );

  const logButton =
    showLogButton && onToggleLog ? (
      <button
        type="button"
        className={[
          'ml-auto text-[10px]',
          activeLogId === stub.id ? 'text-accent' : 'text-muted',
        ].join(' ')}
        onClick={() => onToggleLog(stub.id)}
      >
        log
      </button>
    ) : null;

  if (stub.status === INTERACTION_STATUSES.running) {
    return (
      <div className="rounded-lg bg-surface-alt p-2.5">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-[0.05em]">
            AI Review
          </span>
          <span className="text-[10px] font-semibold uppercase">Running…</span>
          {stub.tool && <span className="text-[10px]">{stub.tool}</span>}
          {logButton}
        </div>
      </div>
    );
  }

  const ri = metaQuery.data;
  if (!ri && metaQuery.isLoading) {
    return (
      <div className="rounded-lg bg-surface-alt p-2.5">
        <div className="flex items-center gap-2 text-[10px] text-muted">
          Loading review...
        </div>
      </div>
    );
  }
  if (!ri) return null;

  if (ri.status === INTERACTION_STATUSES.failed) {
    return (
      <div className="rounded-lg border border-danger/30 bg-danger/10 p-2.5">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-[0.05em]">
            AI Review
          </span>
          <span className="text-[10px] font-semibold uppercase">Failed</span>
          {logButton}
        </div>
        {ri.error && (
          <div className="mt-1 whitespace-pre-wrap text-xs">{ri.error}</div>
        )}
      </div>
    );
  }

  if (!ri.qualityJson) return null;

  const parsed = parseJSONText(ri.qualityJson);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }

  const result = parsed as Partial<AIReviewResult>;
  if (typeof result.feedback !== 'string') return null;
  const cost =
    ri.estimatedCost > 0 ? `$${ri.estimatedCost.toFixed(2)}` : undefined;

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.05em]">
        <span>AI Review</span>
        {logButton}
      </div>
      <ReviewResultCard
        approved={result.approved === true}
        feedback={result.feedback}
        taskId={result.taskId}
        tool={typeof result.tool === 'string' ? result.tool : ri.tool}
        prompt={typeof result.prompt === 'string' ? result.prompt : undefined}
        cost={cost}
        dismissed={dismissed}
      />
    </div>
  );
}
