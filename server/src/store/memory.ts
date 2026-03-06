import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  notInArray,
  type SQL,
  sql,
} from 'drizzle-orm';
import type { EventSink } from '../api/ws';
import type { OrcaDrizzleDB } from '../db/connection';
import {
  memoryEntries,
  memoryFileAssociations,
  meta,
  taskInteractions,
  tasks,
} from '../db/schema';
import type { VectorStore } from '../embedding/vector-store';
import { log } from '../shared/logger';
import type { MemoryEntry, MemorySourceType, MemoryUsedByTask } from '../types';
import type {
  MemoryEntryInput,
  MemoryHealthSummary,
  MemoryListOptions,
  MemoryUpdateFields,
} from './types';

type MemoryRow = typeof memoryEntries.$inferSelect;

export class MemoryStore {
  private vectorStore: VectorStore | null = null;

  constructor(
    private readonly db: OrcaDrizzleDB,
    private readonly sink?: EventSink,
  ) {}

  setVectorStore(vs: VectorStore): void {
    this.vectorStore = vs;
  }

  getVectorStore(): VectorStore | null {
    return this.vectorStore;
  }

  async getMeta(key: string): Promise<string> {
    const normalized = key.trim();
    if (!normalized) return '';

    const rows = await this.db
      .select({ value: meta.value })
      .from(meta)
      .where(eq(meta.key, normalized))
      .limit(1);
    return rows[0]?.value?.trim() ?? '';
  }

  async setMeta(key: string, value: string): Promise<void> {
    const normalized = key.trim();
    if (!normalized) return;

    const trimmedValue = value.trim();
    await this.db
      .insert(meta)
      .values({
        key: normalized,
        value: trimmedValue,
      })
      .onConflictDoUpdate({
        target: meta.key,
        set: {
          value: trimmedValue,
        },
      });
  }

  async create(input: MemoryEntryInput): Promise<MemoryEntry> {
    const content = input.content.trim();
    const category = input.category.trim();
    const provenanceHash = input.provenanceHash.trim();
    if (!content) throw new Error('content required');
    if (!category) throw new Error('category required');
    if (!provenanceHash) throw new Error('provenanceHash required');

    const id = input.id?.trim() || crypto.randomUUID();
    const tags = normalizeTags(input.tags ?? []);
    const sourceType = normalizeSourceType(input.sourceType);
    const confidence = input.confidence ?? 1.0;
    const covered = (input.coveredAtCommit ?? '').trim();
    const stale = Boolean(input.stale);
    const filePaths = normalizePaths(input.filePaths ?? []);

    await this.db.transaction(async (tx) => {
      await tx.insert(memoryEntries).values({
        id,
        content,
        category,
        tags: JSON.stringify(tags),
        sourceTaskId: nullable(input.sourceTaskId),
        sourceInteractionId: nullable(input.sourceInteractionId),
        confidence,
        provenanceHash,
        supersededBy: nullable(input.supersededBy),
        sourceType,
        coveredAtCommit: covered,
        stale,
        createdAt: sql`(CURRENT_TIMESTAMP)`,
        updatedAt: sql`(CURRENT_TIMESTAMP)`,
      });

      for (const filePath of filePaths) {
        await tx
          .insert(memoryFileAssociations)
          .values({
            memoryId: id,
            filePath,
          })
          .onConflictDoNothing({
            target: [
              memoryFileAssociations.memoryId,
              memoryFileAssociations.filePath,
            ],
          });
      }
    });

    const created = await this.get(id);
    if (!created) throw new Error(`failed to create memory entry ${id}`);

    if (this.vectorStore) {
      await this.vectorStore.upsert(id, content);
    }

    this.sink?.broadcast('memory.sync', { id, op: 'INSERT' });
    return created;
  }

  async get(id: string): Promise<MemoryEntry | null> {
    const rows = await this.db
      .select()
      .from(memoryEntries)
      .where(eq(memoryEntries.id, id))
      .limit(1);
    const row = rows[0] ?? null;
    if (!row) return null;
    const mapped = this.mapRow(row);
    mapped.filePaths = await this.getFilePaths(id);
    return mapped;
  }

  async getByProvenanceHash(hash: string): Promise<MemoryEntry | null> {
    const normalized = hash.trim();
    if (!normalized) return null;

    const rows = await this.db
      .select()
      .from(memoryEntries)
      .where(eq(memoryEntries.provenanceHash, normalized))
      .orderBy(desc(memoryEntries.createdAt))
      .limit(1);
    const row = rows[0] ?? null;
    if (!row) return null;
    const mapped = this.mapRow(row);
    mapped.filePaths = await this.getFilePaths(mapped.id);
    return mapped;
  }

  async hasProvenanceHash(hash: string): Promise<boolean> {
    return Boolean(await this.getByProvenanceHash(hash));
  }

  async list(opts: MemoryListOptions = {}): Promise<MemoryEntry[]> {
    const conditions: SQL[] = [isNull(memoryEntries.supersededBy)];

    if (opts.category?.trim()) {
      conditions.push(eq(memoryEntries.category, opts.category.trim()));
    }
    if (opts.tag?.trim()) {
      const tag = opts.tag.trim();
      conditions.push(
        sql`EXISTS (SELECT 1 FROM json_each(${memoryEntries.tags}) WHERE value = ${tag})`,
      );
    }
    if (opts.sourceType?.trim()) {
      conditions.push(
        eq(memoryEntries.sourceType, normalizeSourceType(opts.sourceType)),
      );
    }
    if (opts.filePath?.trim()) {
      const filePath = opts.filePath.trim();
      const existsForPath = this.db
        .select({ one: sql<number>`1` })
        .from(memoryFileAssociations)
        .where(
          and(
            eq(memoryFileAssociations.memoryId, memoryEntries.id),
            eq(memoryFileAssociations.filePath, filePath),
          ),
        );
      conditions.push(exists(existsForPath));
    }
    if (opts.staleOnly) {
      conditions.push(eq(memoryEntries.stale, true));
    }
    if (opts.coveredBefore?.trim()) {
      conditions.push(
        sql`(${memoryEntries.coveredAtCommit} = '' OR ${memoryEntries.coveredAtCommit} <> ${opts.coveredBefore.trim()})`,
      );
    }

    const rows = await this.db
      .select()
      .from(memoryEntries)
      .where(and(...conditions))
      .orderBy(asc(memoryEntries.createdAt));
    const entries = rows.map((row) => this.mapRow(row));
    await this.loadFilePaths(entries);
    return entries;
  }

  async update(id: string, fields: MemoryUpdateFields): Promise<void> {
    const updateSet: Partial<{
      content: string;
      category: string;
      confidence: number;
      sourceType: MemorySourceType;
      stale: boolean;
      coveredAtCommit: string;
      tags: string;
      updatedAt: SQL;
    }> = {};

    if (fields.content !== undefined) {
      updateSet.content = fields.content;
    }
    if (fields.category !== undefined) {
      updateSet.category = fields.category;
    }
    if (fields.confidence !== undefined) {
      updateSet.confidence = fields.confidence;
    }
    if (fields.sourceType !== undefined) {
      updateSet.sourceType = normalizeSourceType(fields.sourceType);
    }
    if (fields.stale !== undefined) {
      updateSet.stale = Boolean(fields.stale);
    }
    if (fields.coveredAtCommit !== undefined) {
      updateSet.coveredAtCommit = fields.coveredAtCommit.trim();
    }
    if (fields.tags !== undefined) {
      updateSet.tags = JSON.stringify(normalizeTags(fields.tags));
    }

    if (Object.keys(updateSet).length === 0) return;

    updateSet.updatedAt = sql`(CURRENT_TIMESTAMP)`;

    const result = await this.db
      .update(memoryEntries)
      .set(updateSet)
      .where(eq(memoryEntries.id, id))
      .returning({ id: memoryEntries.id });
    if (result.length === 0) {
      throw new Error(`memory entry ${id} not found`);
    }

    if (this.vectorStore && fields.content !== undefined) {
      const entry = await this.get(id);
      if (entry) await this.vectorStore.upsert(id, entry.content);
    }

    this.sink?.broadcast('memory.sync', { id, op: 'UPDATE' });
  }

  async delete(id: string): Promise<void> {
    const result = await this.db
      .delete(memoryEntries)
      .where(eq(memoryEntries.id, id))
      .returning({ id: memoryEntries.id });
    if (result.length === 0) {
      throw new Error(`memory entry ${id} not found`);
    }
    if (this.vectorStore) {
      await this.vectorStore.remove(id);
    }
    this.sink?.broadcast('memory.sync', { id, op: 'DELETE' });
  }

  async search(query: string, limit: number): Promise<MemoryEntry[]> {
    const scored = await this.vectorSearch(query, limit, []);
    return scored.map((s) => s.entry);
  }

  async searchWithScores(
    query: string,
    limit: number,
  ): Promise<Array<{ entry: MemoryEntry; score: number }>> {
    return this.vectorSearch(query, limit, []);
  }

  async searchExcluding(
    query: string,
    limit: number,
    excludeHashes: string[],
  ): Promise<MemoryEntry[]> {
    const scored = await this.vectorSearch(query, limit, excludeHashes);
    return scored.map((s) => s.entry);
  }

  private async vectorSearch(
    query: string,
    limit: number,
    excludeHashes: string[],
  ): Promise<Array<{ entry: MemoryEntry; score: number }>> {
    if (!this.vectorStore || !query.trim() || limit <= 0) return [];

    const candidates = await this.vectorStore.search(query, limit * 3);
    if (candidates.length === 0) return [];

    const ids = candidates.map((c) => c.memoryId);
    const distanceMap = new Map(
      candidates.map((c) => [c.memoryId, c.distance]),
    );
    const rows = await this.db
      .select()
      .from(memoryEntries)
      .where(
        and(
          inArray(memoryEntries.id, ids),
          isNull(memoryEntries.supersededBy),
          gte(memoryEntries.confidence, 0.3),
          ...(excludeHashes.length > 0
            ? [notInArray(memoryEntries.provenanceHash, excludeHashes)]
            : []),
        ),
      );

    const idOrder = new Map(ids.map((id, i) => [id, i]));
    const entries = rows
      .map((row) => this.mapRow(row as MemoryRow))
      .sort((a, b) => (idOrder.get(a.id) ?? 999) - (idOrder.get(b.id) ?? 999))
      .slice(0, limit);

    await this.loadFilePaths(entries);
    return entries.map((entry) => ({
      entry,
      score: Math.round((1 - (distanceMap.get(entry.id) ?? 1)) * 100) / 100,
    }));
  }

  async supersede(oldID: string, newID: string): Promise<void> {
    const result = await this.db
      .update(memoryEntries)
      .set({
        supersededBy: newID,
        updatedAt: sql`(CURRENT_TIMESTAMP)`,
      })
      .where(eq(memoryEntries.id, oldID))
      .returning({ id: memoryEntries.id });
    if (result.length === 0) {
      throw new Error(`memory entry ${oldID} not found`);
    }
    this.sink?.broadcast('memory.sync', { id: oldID, op: 'UPDATE' });
  }

  async decayConfidence(olderThanMs: number, factor: number): Promise<number> {
    if (olderThanMs <= 0) throw new Error('olderThanMs must be > 0');
    if (factor <= 0) throw new Error('factor must be > 0');
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    const usedMemoryIDs = await this.loadUsedMemoryIDsSince(cutoff);

    const conditions: SQL[] = [
      lt(memoryEntries.updatedAt, cutoff),
      isNull(memoryEntries.supersededBy),
      gt(memoryEntries.confidence, 0.1),
    ];

    if (usedMemoryIDs.length > 0) {
      conditions.push(notInArray(memoryEntries.id, usedMemoryIDs));
    }

    const result = await this.db
      .update(memoryEntries)
      .set({
        confidence: sql`${memoryEntries.confidence} * ${factor}`,
        updatedAt: sql`(CURRENT_TIMESTAMP)`,
      })
      .where(and(...conditions))
      .returning({ id: memoryEntries.id });

    return result.length;
  }

  async associateFiles(entryID: string, paths: string[]): Promise<void> {
    const normalizedEntryID = entryID.trim();
    const normalizedPaths = normalizePaths(paths);
    if (!normalizedEntryID || normalizedPaths.length === 0) return;

    await this.db.transaction(async (tx) => {
      for (const filePath of normalizedPaths) {
        await tx
          .insert(memoryFileAssociations)
          .values({
            memoryId: normalizedEntryID,
            filePath,
          })
          .onConflictDoNothing({
            target: [
              memoryFileAssociations.memoryId,
              memoryFileAssociations.filePath,
            ],
          });
      }
    });
  }

  async getFilePaths(entryID: string): Promise<string[]> {
    const normalized = entryID.trim();
    if (!normalized) return [];

    const rows = await this.db
      .select({ filePath: memoryFileAssociations.filePath })
      .from(memoryFileAssociations)
      .where(eq(memoryFileAssociations.memoryId, normalized))
      .orderBy(asc(memoryFileAssociations.filePath));
    return rows.map((row) => String(row.filePath));
  }

  async renameFilePathAssociations(
    oldPath: string,
    newPath: string,
  ): Promise<number> {
    const oldNormalized = oldPath.trim();
    const newNormalized = newPath.trim();
    if (!oldNormalized || !newNormalized || oldNormalized === newNormalized)
      return 0;

    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select({ memoryId: memoryFileAssociations.memoryId })
        .from(memoryFileAssociations)
        .where(eq(memoryFileAssociations.filePath, oldNormalized))
        .orderBy(asc(memoryFileAssociations.memoryId));

      for (const row of rows) {
        await tx
          .insert(memoryFileAssociations)
          .values({
            memoryId: row.memoryId,
            filePath: newNormalized,
          })
          .onConflictDoNothing({
            target: [
              memoryFileAssociations.memoryId,
              memoryFileAssociations.filePath,
            ],
          });
      }

      const result = await tx
        .delete(memoryFileAssociations)
        .where(eq(memoryFileAssociations.filePath, oldNormalized))
        .returning({ memoryId: memoryFileAssociations.memoryId });
      return result.length;
    });
  }

  async findByFilePaths(paths: string[]): Promise<MemoryEntry[]> {
    const normalizedPaths = normalizePaths(paths);
    if (normalizedPaths.length === 0) return [];

    const rows = await this.db
      .select({
        id: memoryEntries.id,
        content: memoryEntries.content,
        category: memoryEntries.category,
        tags: memoryEntries.tags,
        sourceTaskId: memoryEntries.sourceTaskId,
        sourceInteractionId: memoryEntries.sourceInteractionId,
        confidence: memoryEntries.confidence,
        provenanceHash: memoryEntries.provenanceHash,
        supersededBy: memoryEntries.supersededBy,
        sourceType: memoryEntries.sourceType,
        coveredAtCommit: memoryEntries.coveredAtCommit,
        stale: memoryEntries.stale,
        createdAt: memoryEntries.createdAt,
        updatedAt: memoryEntries.updatedAt,
      })
      .from(memoryEntries)
      .innerJoin(
        memoryFileAssociations,
        eq(memoryFileAssociations.memoryId, memoryEntries.id),
      )
      .where(
        and(
          isNull(memoryEntries.supersededBy),
          inArray(memoryFileAssociations.filePath, normalizedPaths),
        ),
      )
      .orderBy(asc(memoryEntries.createdAt));
    const entries = rows.map((row) => this.mapRow(row as MemoryRow));
    await this.loadFilePaths(entries);
    return entries;
  }

  async boostConfidence(id: string, factor: number): Promise<void> {
    if (factor <= 0) throw new Error('factor must be > 0');
    const result = await this.db
      .update(memoryEntries)
      .set({
        confidence: sql`min(1.0, ${memoryEntries.confidence} * ${factor})`,
        updatedAt: sql`(CURRENT_TIMESTAMP)`,
      })
      .where(eq(memoryEntries.id, id))
      .returning({ id: memoryEntries.id });
    if (result.length === 0) {
      throw new Error(`memory entry ${id} not found`);
    }
  }

  async decayEntry(id: string, factor: number): Promise<void> {
    if (factor <= 0) throw new Error('factor must be > 0');
    const result = await this.db
      .update(memoryEntries)
      .set({
        confidence: sql`max(0.1, ${memoryEntries.confidence} * ${factor})`,
        updatedAt: sql`(CURRENT_TIMESTAMP)`,
      })
      .where(eq(memoryEntries.id, id))
      .returning({ id: memoryEntries.id });
    if (result.length === 0) {
      throw new Error(`memory entry ${id} not found`);
    }
  }

  async markStale(id: string): Promise<void> {
    const result = await this.db
      .update(memoryEntries)
      .set({
        stale: true,
        updatedAt: sql`(CURRENT_TIMESTAMP)`,
      })
      .where(eq(memoryEntries.id, id))
      .returning({ id: memoryEntries.id });
    if (result.length === 0) {
      throw new Error(`memory entry ${id} not found`);
    }
  }

  async updateCoveredCommit(id: string, commitSHA: string): Promise<void> {
    const result = await this.db
      .update(memoryEntries)
      .set({
        coveredAtCommit: commitSHA.trim(),
        updatedAt: sql`(CURRENT_TIMESTAMP)`,
      })
      .where(eq(memoryEntries.id, id))
      .returning({ id: memoryEntries.id });
    if (result.length === 0) {
      throw new Error(`memory entry ${id} not found`);
    }
  }

  async findStaleEntries(): Promise<MemoryEntry[]> {
    const rows = await this.db
      .select()
      .from(memoryEntries)
      .where(
        and(isNull(memoryEntries.supersededBy), eq(memoryEntries.stale, true)),
      )
      .orderBy(asc(memoryEntries.updatedAt));
    const entries = rows.map((row) => this.mapRow(row));
    await this.loadFilePaths(entries);
    return entries;
  }

  async findUsedByTasks(entryID: string): Promise<MemoryUsedByTask[]> {
    const normalized = entryID.trim();
    if (!normalized) return [];

    const rows = await this.db
      .select({
        taskId: tasks.id,
        title: tasks.title,
        status: tasks.status,
        qualityJson: taskInteractions.qualityJson,
      })
      .from(taskInteractions)
      .innerJoin(tasks, eq(tasks.id, taskInteractions.taskId))
      .where(isNotNull(taskInteractions.taskId))
      .orderBy(desc(tasks.updatedAt));

    const seen = new Set<string>();
    const out: MemoryUsedByTask[] = [];
    for (const row of rows) {
      if (seen.has(row.taskId)) continue;
      const used = parseUsedMemoryIDs(row.qualityJson);
      if (!used.includes(normalized)) continue;
      seen.add(row.taskId);
      out.push({
        taskId: row.taskId,
        title: row.title,
        status: row.status,
      });
    }

    return out;
  }

  async findSupersededIDs(entryID: string): Promise<string[]> {
    const normalized = entryID.trim();
    if (!normalized) return [];
    const rows = await this.db
      .select({ id: memoryEntries.id })
      .from(memoryEntries)
      .where(eq(memoryEntries.supersededBy, normalized))
      .orderBy(asc(memoryEntries.createdAt));
    return rows.map((row) => String(row.id));
  }

  async buildHealthSummary(): Promise<MemoryHealthSummary> {
    const bySourceRows = await this.db
      .select({
        sourceType: memoryEntries.sourceType,
        count: sql<number>`count(*)`.as('count'),
      })
      .from(memoryEntries)
      .where(isNull(memoryEntries.supersededBy))
      .groupBy(memoryEntries.sourceType);

    const bySource: Record<MemorySourceType, number> = {
      retro: 0,
      explore: 0,
    };
    let totalEntries = 0;
    for (const row of bySourceRows) {
      const count = Number(row.count ?? 0);
      bySource[row.sourceType as MemorySourceType] = count;
      totalEntries += count;
    }

    const staleRows = await this.db
      .select({
        count: sql<number>`count(*)`.as('count'),
      })
      .from(memoryEntries)
      .where(
        and(isNull(memoryEntries.supersededBy), eq(memoryEntries.stale, true)),
      );

    const avgRows = await this.db
      .select({
        avgConfidence:
          sql<number>`coalesce(avg(${memoryEntries.confidence}), 0)`.as(
            'avgConfidence',
          ),
      })
      .from(memoryEntries)
      .where(isNull(memoryEntries.supersededBy));

    return {
      totalEntries,
      bySource,
      staleCount: Number(staleRows[0]?.count ?? 0),
      avgConfidence: Number(avgRows[0]?.avgConfidence ?? 0),
    };
  }

  async reembedAll(batchSize = 50): Promise<number> {
    if (!this.vectorStore) return 0;
    await this.db
      .update(memoryEntries)
      .set({ embedding: null })
      .where(isNull(memoryEntries.supersededBy));
    return this.backfillEmbeddings(batchSize);
  }

  async backfillEmbeddings(batchSize = 50): Promise<number> {
    if (!this.vectorStore) return 0;

    const allRows = await this.db
      .select({ id: memoryEntries.id, content: memoryEntries.content })
      .from(memoryEntries)
      .where(
        and(
          isNull(memoryEntries.supersededBy),
          isNull(memoryEntries.embedding),
        ),
      )
      .orderBy(asc(memoryEntries.createdAt));

    const missing = allRows;
    if (missing.length === 0) return 0;

    log.info('backfilling embeddings', { count: missing.length });
    let embedded = 0;
    for (let i = 0; i < missing.length; i += batchSize) {
      const batch = missing.slice(i, i + batchSize);
      try {
        await this.vectorStore.upsertBatch(
          batch.map((r) => ({ id: r.id, text: r.content })),
        );
        embedded += batch.length;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn('backfill batch failed', { offset: i, error: msg });
        break;
      }
    }
    log.info('backfill complete', { embedded, total: missing.length });
    return embedded;
  }

  private mapRow(row: MemoryRow): MemoryEntry {
    return {
      id: row.id,
      content: row.content,
      category: row.category as any,
      tags: parseTags(row.tags),
      sourceTaskId: row.sourceTaskId ?? undefined,
      sourceInteractionId: row.sourceInteractionId ?? undefined,
      sourceType: row.sourceType as MemorySourceType,
      filePaths: [],
      coveredAtCommit: (row.coveredAtCommit ?? '').trim(),
      stale: Boolean(row.stale),
      confidence: Number(row.confidence ?? 1),
      provenanceHash: row.provenanceHash,
      supersededBy: row.supersededBy ?? undefined,
      createdAt: String(row.createdAt),
      updatedAt: String(row.updatedAt),
    };
  }

  private async loadFilePaths(entries: MemoryEntry[]): Promise<void> {
    for (const entry of entries) {
      entry.filePaths = await this.getFilePaths(entry.id);
    }
  }

  private async loadUsedMemoryIDsSince(cutoffISO: string): Promise<string[]> {
    const rows = await this.db
      .select({
        qualityJson: taskInteractions.qualityJson,
      })
      .from(taskInteractions)
      .where(
        and(
          eq(taskInteractions.status, 'completed'),
          sql`coalesce(${taskInteractions.finishedAt}, ${taskInteractions.startedAt}) >= ${cutoffISO}`,
        ),
      );

    const seen = new Set<string>();
    for (const row of rows) {
      for (const id of parseUsedMemoryIDs(row.qualityJson)) {
        seen.add(id);
      }
    }

    return [...seen];
  }
}

function nullable(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? '';
  return normalized || null;
}

function normalizeSourceType(
  value: string | null | undefined,
): MemorySourceType {
  const normalized = (value ?? 'retro').trim().toLowerCase();
  if (normalized === 'retro' || normalized === 'explore') {
    return normalized;
  }
  throw new Error(`invalid sourceType ${JSON.stringify(value)}`);
}

function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))].sort(
    (a, b) => a.localeCompare(b),
  );
}

function normalizePaths(paths: string[]): string[] {
  return [...new Set(paths.map((path) => path.trim()).filter(Boolean))].sort(
    (a, b) => a.localeCompare(b),
  );
}

function parseTags(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((tag) => String(tag)).filter(Boolean);
  }

  if (typeof raw === 'string') {
    if (!raw.trim()) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.map((tag) => String(tag)).filter(Boolean);
      }
    } catch {
      return [];
    }
  }

  return [];
}

function parseUsedMemoryIDs(raw: string | null | undefined): string[] {
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const used = parsed.usedMemoryIds ?? parsed.used_memory_ids;
    if (!Array.isArray(used)) return [];
    return used.map((value) => String(value).trim()).filter(Boolean);
  } catch {
    return [];
  }
}
