import type { InteractionStatus } from '@orca/types';
import type { taskInteractions } from '../db/schema';
import type { InteractionStub } from '../types/models';
import type { StoredInteraction } from './types';

type InteractionRow = typeof taskInteractions.$inferSelect;

interface ParsedOutput {
  result: string;
  data: Record<string, unknown>;
}

export function mapInteractionRow(row: InteractionRow): StoredInteraction {
  return {
    id: row.id,
    taskId: row.taskId,
    type: row.type,
    stepName: row.stepName,
    attempt: row.attempt,
    tool: row.tool,
    model: row.model,
    logPath: row.logPath,
    status: row.status as InteractionStatus,
    error: row.error ?? undefined,
    output: row.output,
    exitCode: row.exitCode ?? undefined,
    durationMs: row.durationMs ?? undefined,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    previousInteractionId: row.previousInteractionId,
    commitSha: row.commitSha,
    sessionId: row.sessionId,
    chainId: row.chainId,
  };
}

export function mapInteractionStub(row: InteractionRow): InteractionStub {
  const parsed = parseOutputJSON(row.output);
  const filesChanged = Array.isArray(parsed?.data.filesChanged)
    ? (parsed.data.filesChanged as string[])
    : [];

  return {
    id: row.id,
    taskId: row.taskId,
    type: row.type,
    stepName: row.stepName ?? undefined,
    attempt: row.attempt,
    tool: row.tool,
    status: row.status as InteractionStatus,
    durationMs: row.durationMs ?? undefined,
    diffSummary:
      filesChanged.length > 0 ? `${filesChanged.length} files` : null,
    memoryCount: parseMemoryCount(parsed),
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    previousInteractionId: row.previousInteractionId ?? undefined,
    commitSha: row.commitSha ?? undefined,
    sessionId: row.sessionId ?? undefined,
  };
}

function parseOutputJSON(raw: string | null | undefined): ParsedOutput | null {
  if (!raw?.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;
    return {
      result: typeof obj.result === 'string' ? obj.result : '',
      data: (obj.data && typeof obj.data === 'object'
        ? obj.data
        : {}) as Record<string, unknown>,
    };
  } catch {
    return null;
  }
}

function parseMemoryCount(parsed: ParsedOutput | null): number | undefined {
  if (!parsed) return undefined;
  const ids = parsed.data.usedMemoryIds ?? parsed.data.used_memory_ids;
  if (Array.isArray(ids) && ids.length > 0) return ids.length;
  return undefined;
}
