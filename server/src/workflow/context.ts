import type { InteractionStore } from '../store/interactions';
import { extractWorkflowOutput } from './output';

/**
 * Assembles context from prior step outputs for the current step.
 * Each consumed step's most recent completed interaction is queried,
 * and its output is extracted from the standardized output JSON field.
 */
export async function assembleConsumedContext(opts: {
  taskId: string;
  consumes: string[];
  interactionStore: InteractionStore;
}): Promise<string> {
  const { taskId, consumes, interactionStore } = opts;
  if (!consumes || consumes.length === 0) return '';

  const blocks: string[] = [];

  for (const stepName of consumes) {
    const content = await getStepOutput(taskId, stepName, interactionStore);
    if (content.trim()) {
      blocks.push(`## Output from: ${stepName}\n\n${content.trim()}`);
    }
  }

  return blocks.join('\n\n---\n\n');
}

/**
 * Generic step output extractor. Gets the most recent completed interaction
 * for a given step name and extracts its output from the standardized output field.
 */
export async function getStepOutput(
  taskId: string,
  stepName: string,
  interactionStore: InteractionStore,
): Promise<string> {
  const interactions = await interactionStore.listByStepName(taskId, stepName);
  const completed = interactions.find((ix) => ix.status === 'completed');
  if (!completed) return '';
  return extractInteractionOutput(completed);
}

/**
 * Checks whether a completed interaction exists for the given step.
 */
export async function hasStepOutput(
  taskId: string,
  stepName: string,
  interactionStore: InteractionStore,
): Promise<boolean> {
  const interactions = await interactionStore.listByStepName(taskId, stepName);
  return interactions.some((ix) => ix.status === 'completed');
}

function extractInteractionOutput(interaction: {
  output?: string | null;
}): string {
  return extractWorkflowOutput(interaction.output);
}
