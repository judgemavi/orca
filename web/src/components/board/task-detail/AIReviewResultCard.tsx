import type { AIReviewResult, Interaction } from '../../../types'
import { INTERACTION_STATUSES } from '../../../lib/phases'
import { useInteractionDetailContext } from './InteractionDetailContext'
import { parseJSONText } from '../../../lib/orchestratorRichContent'
import { ReviewResultCard } from '../../shared/ReviewResultCard'

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

  const parsed = parseJSONText(ri.quality_json)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null
  }

  const result = parsed as Partial<AIReviewResult>
  if (typeof result.feedback !== 'string') return null
  const cost = ri.estimated_cost > 0 ? `$${ri.estimated_cost.toFixed(2)}` : undefined

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.05em]">
        <span>AI Review</span>
        {logButton}
      </div>
      <ReviewResultCard
        approved={result.approved === true}
        feedback={result.feedback}
        taskId={result.task_id}
        tool={typeof result.tool === 'string' ? result.tool : ri.tool}
        prompt={typeof result.prompt === 'string' ? result.prompt : undefined}
        cost={cost}
        dismissed={dismissed}
      />
    </div>
  )
}
