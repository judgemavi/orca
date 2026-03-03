export interface EvaluationCardProps {
  complexity?: string
  needsBreakdown: boolean
  confidence?: number
  reasoning: string
}

function confidencePercent(confidence: number | undefined): string {
  if (!Number.isFinite(confidence)) return '-'
  if ((confidence ?? 0) <= 1) return `${Math.round((confidence ?? 0) * 100)}%`
  return `${Math.round(confidence ?? 0)}%`
}

function complexityLabel({
  complexity,
  needsBreakdown,
}: Pick<EvaluationCardProps, 'complexity' | 'needsBreakdown'>): string {
  if (complexity?.trim()) return complexity.trim()
  return needsBreakdown ? 'high' : 'moderate'
}

export function EvaluationCard({
  complexity,
  needsBreakdown,
  confidence,
  reasoning,
}: EvaluationCardProps) {
  return (
    <div
      className={[
        'rounded-lg p-3',
        needsBreakdown
          ? 'bg-amber-500/10 shadow-sm shadow-amber-500/10'
          : 'bg-emerald-500/10 shadow-sm shadow-emerald-500/10',
      ].join(' ')}
    >
      <div className="mb-2 flex flex-wrap items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.05em]">
        <span>Evaluation</span>
        <span className={needsBreakdown ? 'text-amber-400' : 'text-emerald-400'}>
          {needsBreakdown ? 'Breakdown Recommended' : 'Ready To Plan'}
        </span>
      </div>
      <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <span>
          Complexity:{' '}
          <span className="font-medium capitalize">
            {complexityLabel({ complexity, needsBreakdown })}
          </span>
        </span>
        <span>
          Confidence: <span className="font-medium">{confidencePercent(confidence)}</span>
        </span>
        <span>
          Needs Breakdown:{' '}
          <span className="font-medium">{needsBreakdown ? 'Yes' : 'No'}</span>
        </span>
      </div>
      <div className="whitespace-pre-wrap text-xs">{reasoning}</div>
    </div>
  )
}
