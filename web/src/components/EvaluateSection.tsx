import { INTERACTION_STATUSES } from '@orca/server/types';
import {
  parseEvaluationPayload,
  parseJSONText,
} from '../lib/orchestratorRichContent';
import type { Interaction } from '../types';
import { EvaluationCard } from './EvaluationCard';

type Props = {
  interaction: Interaction;
};

export function EvaluateSection({ interaction }: Props) {
  if (
    interaction.type !== 'evaluate' ||
    interaction.status !== INTERACTION_STATUSES.completed ||
    !interaction.qualityJson
  ) {
    return null;
  }

  const evaluation = parseEvaluationPayload(
    parseJSONText(interaction.qualityJson),
  );
  if (!evaluation) return null;

  return (
    <EvaluationCard
      complexity={evaluation.complexity}
      needsBreakdown={evaluation.needsBreakdown}
      confidence={evaluation.confidence}
      reasoning={evaluation.reasoning}
    />
  );
}
