import type { ProposedTask } from '../types';

interface ParsedEvaluation {
  complexity?: string;
  needsBreakdown: boolean;
  confidence?: number;
  reasoning: string;
}

interface ParsedBreakdown {
  proposed: ProposedTask[];
  accepted?: boolean;
  rejected?: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function asNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const out: number[] = [];
  for (const item of value) {
    const parsed = asNumber(item);
    if (Number.isFinite(parsed)) out.push(Math.trunc(parsed as number));
  }
  return out;
}

export function parseEvaluationPayload(
  payload: unknown,
): ParsedEvaluation | null {
  const sourceRoot = asRecord(payload);
  const source = asRecord(sourceRoot?.evaluation) ?? sourceRoot;
  if (!source) return null;

  const needsBreakdownSource =
    typeof source.needsBreakdown === 'boolean'
      ? source.needsBreakdown
      : typeof source.needsBreakdown === 'boolean'
        ? source.needsBreakdown
        : null;
  const reasoningSource = asString(source.reasoning).trim();
  if (needsBreakdownSource === null || !reasoningSource) return null;

  return {
    complexity: asString(source.complexity).trim() || undefined,
    needsBreakdown: needsBreakdownSource,
    confidence: asNumber(source.confidence),
    reasoning: reasoningSource,
  };
}

export function parseBreakdownPayload(
  payload: unknown,
): ParsedBreakdown | null {
  const source = asRecord(payload);
  if (!source) return null;

  const rawProposed = Array.isArray(source.proposed)
    ? source.proposed
    : Array.isArray(source.proposedTasks)
      ? source.proposedTasks
      : [];
  const proposed: ProposedTask[] = [];
  for (const rawTask of rawProposed) {
    const task = asRecord(rawTask);
    if (!task) continue;
    const title = asString(task.title).trim();
    const description = asString(task.description).trim();
    if (!title && !description) continue;
    proposed.push({
      title: title || 'Untitled task',
      description,
      dependsOnIndices: asNumberArray(task.dependsOnIndices ?? task.dependsOn),
      suggestedTool: asString(task.suggestedTool ?? task.tool).trim(),
    });
  }

  const accepted =
    typeof source.accepted === 'boolean' ? source.accepted : undefined;
  const rejected =
    typeof source.rejected === 'boolean' ? source.rejected : undefined;
  if (
    proposed.length === 0 &&
    accepted === undefined &&
    rejected === undefined
  ) {
    return null;
  }

  return {
    proposed,
    accepted,
    rejected,
  };
}
