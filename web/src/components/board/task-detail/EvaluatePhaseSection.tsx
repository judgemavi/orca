import type { Interaction } from '../../../types'
import { INTERACTION_STATUSES, PHASES } from '@orca/types'
import {
  parseEvaluationPayload,
  parseJSONText,
} from '../../../lib/orchestratorRichContent'
import { EvaluationCard } from '../../shared/EvaluationCard'

type Props = {
  interaction: Interaction
}

export function EvaluatePhaseSection({ interaction }: Props) {
  if (
    interaction.phase !== PHASES.evaluate ||
    interaction.status !== INTERACTION_STATUSES.completed ||
    !interaction.qualityJson
  ) {
    return null
  }

  const evaluation = parseEvaluationPayload(parseJSONText(interaction.qualityJson))
  if (!evaluation) return null

  return (
    <EvaluationCard
      complexity={evaluation.complexity}
      needsBreakdown={evaluation.needsBreakdown}
      confidence={evaluation.confidence}
      reasoning={evaluation.reasoning}
    />
  )
}
