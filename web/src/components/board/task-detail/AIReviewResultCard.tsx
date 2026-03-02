import type { AIReviewResult, Interaction } from '../../../types'
import { INTERACTION_STATUSES } from '../../../lib/phases'
import { useInteractionDetailContext } from './InteractionDetailContext'

interface Props {
  interaction: Interaction
  dismissed?: boolean
  showLogButton?: boolean
}

export function AIReviewResultCard({
  interaction: ri,
  dismissed,
  showLogButton = false,
}: Props) {
  const detailContext = useInteractionDetailContext()
  const activeLogId = detailContext?.activeLogId ?? null
  const onToggleLog = detailContext?.onToggleLog

  const logButton =
    showLogButton && onToggleLog ? (
      <button
        type="button"
        className={[
          'ml-auto text-[10px]',
          activeLogId === ri.id ? 'text-accent' : 'text-muted',
        ].join(' ')}
        onClick={() => onToggleLog(ri.id)}
      >
        log
      </button>
    ) : null

  if (ri.status === INTERACTION_STATUSES.running) {
    return (
      <div className="rounded-lg bg-surface-alt p-2.5">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-[0.05em]">
            AI Review
          </span>
          <span className="text-[10px] font-semibold uppercase">Running…</span>
          {ri.tool && <span className="text-[10px]">{ri.tool}</span>}
          {logButton}
        </div>
      </div>
    )
  }

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
    )
  }

  if (!ri.quality_json) return null

  try {
    const result: AIReviewResult = JSON.parse(ri.quality_json)
    const costLabel = [
      ri.tool,
      ri.estimated_cost > 0 ? `$${ri.estimated_cost.toFixed(2)}` : null,
    ]
      .filter(Boolean)
      .join(' · ')

    const isDismissed = dismissed && !result.approved

    return (
      <div
        className={[
          'rounded-lg p-2.5',
          isDismissed
            ? 'bg-surface-alt opacity-60'
            : result.approved
              ? 'bg-emerald-500/10 shadow-sm shadow-emerald-500/10'
              : 'bg-amber-500/10 shadow-sm shadow-amber-500/10',
        ].join(' ')}
      >
        <div className="mb-1 flex items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-[0.05em]">
            AI Review
          </span>
          <span
            className={[
              'text-[10px] font-semibold uppercase',
              isDismissed
                ? 'text-muted'
                : result.approved
                  ? 'text-emerald-400'
                  : 'text-amber-400',
            ].join(' ')}
          >
            {isDismissed
              ? 'Dismissed'
              : result.approved
                ? 'Approved'
                : 'Changes Suggested'}
          </span>
          {costLabel && <span className="text-[10px]">{costLabel}</span>}
          {logButton}
        </div>
        {result.prompt && (
          <div className="mb-1.5 rounded bg-surface px-2 py-1.5 text-[11px] italic">
            {result.prompt}
          </div>
        )}
        <div className="whitespace-pre-wrap text-xs">{result.feedback}</div>
      </div>
    )
  } catch {
    return null
  }
}
