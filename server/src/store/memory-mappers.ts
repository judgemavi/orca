import type { memoryEntries } from '../db/schema';
import type { MemorySourceType } from '../types/constants';
import type { MemoryEntry } from '../types/models';
import { parseTags } from './memory-normalize';

export type MemoryRow = typeof memoryEntries.$inferSelect;

export function mapMemoryRow(row: MemoryRow): MemoryEntry {
  return {
    id: row.id,
    content: row.content,
    category: row.category as MemoryEntry['category'],
    tags: parseTags(row.tags),
    sourceTaskId: row.sourceTaskId ?? undefined,
    sourceInteractionId: row.sourceInteractionId ?? undefined,
    sourceType: row.sourceType as MemorySourceType,
    filePaths: [],
    coveredAtCommit: (row.coveredAtCommit ?? '').trim(),
    stale: Boolean(row.stale),
    decayExempt: Boolean(row.decayExempt),
    confidence: Number(row.confidence ?? 1),
    retrievalCount: Number(row.retrievalCount ?? 0),
    provenanceHash: row.provenanceHash,
    supersededBy: row.supersededBy ?? undefined,
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

export function parseUsedMemoryIDs(raw: string | null | undefined): string[] {
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return [];
    const data = (parsed as Record<string, unknown>).data;
    if (!data || typeof data !== 'object') return [];
    const ids =
      (data as Record<string, unknown>).usedMemoryIds ??
      (data as Record<string, unknown>).used_memory_ids;
    if (!Array.isArray(ids)) return [];
    return ids.map((id) => String(id).trim()).filter(Boolean);
  } catch {
    return [];
  }
}
