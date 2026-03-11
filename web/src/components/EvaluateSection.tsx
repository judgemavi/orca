import { INTERACTION_STATUSES } from '@orca/server/types';
import { parseEvaluationPayload } from '../lib/orchestratorRichContent';
import type { Interaction } from '../types';
import { EvaluationCard } from './EvaluationCard';

type Props = {
  interaction: Interaction;
};

function extractEvaluationData(
  output?: string,
): Record<string, unknown> | null {
  if (!output?.trim()) return null;
  try {
    const parsed = JSON.parse(output) as { data?: Record<string, unknown> };
    return parsed.data ?? null;
  } catch {
    return null;
  }
}

export function EvaluateSection({ interaction }: Props) {
  if (
    interaction.type !== 'evaluate' ||
    interaction.status !== INTERACTION_STATUSES.completed ||
    !interaction.output
  ) {
    return null;
  }

  const evaluation = parseEvaluationPayload(
    extractEvaluationData(interaction.output),
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
