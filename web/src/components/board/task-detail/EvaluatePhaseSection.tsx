import type { Interaction, TaskEvaluation } from '../../../types'
import { INTERACTION_STATUSES, PHASES } from '../../../lib/phases'

type ParsedTaskEvaluation = {
  complexity?: string
  needs_breakdown: boolean
  confidence?: number
  reasoning: string
}

function parseTaskEvaluation(
  qualityJSON: string | undefined,
): ParsedTaskEvaluation | null {
  if (!qualityJSON) return null
  try {
    const parsed = JSON.parse(qualityJSON) as Partial<TaskEvaluation>
    const needsBreakdown = parsed.needs_breakdown
    if (
      typeof needsBreakdown !== 'boolean' ||
      typeof parsed.reasoning !== 'string'
    ) {
      return null
    }
    return {
      complexity:
        typeof parsed.complexity === 'string' ? parsed.complexity : undefined,
      needs_breakdown: needsBreakdown,
      confidence:
        typeof parsed.confidence === 'number' ? parsed.confidence : undefined,
      reasoning: parsed.reasoning,
    }
  } catch {
    return null
  }
}

function confidencePercent(confidence: number | undefined): string {
  if (!Number.isFinite(confidence)) return '-'
  if ((confidence ?? 0) <= 1) return `${Math.round((confidence ?? 0) * 100)}`
  return `${Math.round(confidence ?? 0)}`
}

function evaluationComplexityLabel(evaluation: ParsedTaskEvaluation): string {
  if (evaluation.complexity?.trim()) return evaluation.complexity.trim()
  return evaluation.needs_breakdown ? 'high' : 'moderate'
}

type Props = {
  interaction: Interaction
}

export function EvaluatePhaseSection({ interaction }: Props) {
  if (
    interaction.phase !== PHASES.evaluate ||
    interaction.status !== INTERACTION_STATUSES.completed ||
    !interaction.quality_json
  ) {
    return null
  }

  const evaluation = parseTaskEvaluation(interaction.quality_json)
  if (!evaluation) return null

  const requiresBreakdown = evaluation.needs_breakdown

  return (
    <div
      className={[
        'rounded-lg p-3',
        requiresBreakdown
          ? 'bg-amber-500/10 shadow-sm shadow-amber-500/10'
          : 'bg-emerald-500/10 shadow-sm shadow-emerald-500/10',
      ].join(' ')}
    >
      <div className="mb-2 flex flex-wrap items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.05em]">
        <span>Evaluation</span>
        <span
          className={requiresBreakdown ? 'text-amber-400' : 'text-emerald-400'}
        >
          {requiresBreakdown ? 'Breakdown Recommended' : 'Ready To Plan'}
        </span>
      </div>
      <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <span>
          Complexity:{' '}
          <span className="font-medium capitalize">
            {evaluationComplexityLabel(evaluation)}
          </span>
        </span>
        <span>
          Confidence:{' '}
          <span className="font-medium">
            {confidencePercent(evaluation.confidence)}
            {Number.isFinite(evaluation.confidence) ? '%' : ''}
          </span>
        </span>
        <span>
          Needs Breakdown:{' '}
          <span className="font-medium">
            {evaluation.needs_breakdown ? 'Yes' : 'No'}
          </span>
        </span>
      </div>
      <div className="whitespace-pre-wrap text-xs">{evaluation.reasoning}</div>
    </div>
  )
}
