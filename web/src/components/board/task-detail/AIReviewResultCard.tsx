import type { AIReviewResult, Interaction } from '../../../types'

interface Props {
  interaction: Interaction
  dismissed?: boolean
  activeLogId?: string | null
  onToggleLog?: (id: string) => void
}

export function AIReviewResultCard({
  interaction: ri,
  dismissed,
  activeLogId,
  onToggleLog,
}: Props) {
  const logButton = onToggleLog ? (
    <button
      type="button"
      className={[
        'ml-auto text-[10px]',
        activeLogId === ri.id ? 'text-blue-500' : 'text-slate-400',
      ].join(' ')}
      onClick={() => onToggleLog(ri.id)}
    >
      log
    </button>
  ) : null

  if (ri.status === 'running') {
    return (
      <div className="rounded-md border p-2.5">
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

  if (ri.status === 'failed') {
    return (
      <div className="rounded-md border border-red-400/30 bg-red-400/10 p-2.5">
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
          'rounded-md border p-2.5',
          isDismissed
            ? 'border-slate-700 opacity-60'
            : result.approved
              ? 'border-emerald-500/35 bg-emerald-500/10'
              : 'border-amber-500/40 bg-amber-500/10',
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
                ? 'text-slate-400'
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
          <div className="mb-1.5 rounded border px-2 py-1.5 text-[11px] italic">
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
