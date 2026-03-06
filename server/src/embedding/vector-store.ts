import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import type { OrcaDrizzleDB } from '../db/connection';
import { memoryEntries } from '../db/schema';
import { log } from '../shared/logger';
import type { EmbeddingPlugin } from './types';

export class VectorStore {
  constructor(
    private readonly db: OrcaDrizzleDB,
    private readonly plugin: EmbeddingPlugin,
  ) {}

  async upsert(memoryId: string, text: string): Promise<void> {
    const vector = await this.plugin.embed(text);
    const buf = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
    await this.db
      .update(memoryEntries)
      .set({ embedding: buf })
      .where(eq(memoryEntries.id, memoryId));
  }

  async upsertBatch(
    entries: Array<{ id: string; text: string }>,
  ): Promise<void> {
    if (entries.length === 0) return;
    const texts = entries.map((e) => e.text);
    const vectors = await this.plugin.embedBatch(texts);
    for (let i = 0; i < entries.length; i++) {
      const vec = vectors[i];
      if (!vec) continue;
      const buf = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
      await this.db
        .update(memoryEntries)
        .set({ embedding: buf })
        .where(eq(memoryEntries.id, entries[i]!.id));
    }
  }

  async remove(memoryId: string): Promise<void> {
    await this.db
      .update(memoryEntries)
      .set({ embedding: null })
      .where(eq(memoryEntries.id, memoryId));
  }

  async search(
    query: string,
    limit: number,
  ): Promise<Array<{ memoryId: string; distance: number }>> {
    const queryVec = await this.plugin.embed(query);

    const rows = await this.db
      .select({ id: memoryEntries.id, embedding: memoryEntries.embedding })
      .from(memoryEntries)
      .where(
        and(isNotNull(memoryEntries.embedding), isNull(memoryEntries.supersededBy)),
      );

    const scored: Array<{ memoryId: string; distance: number }> = [];
    for (const row of rows) {
      if (!row.embedding) continue;
      const stored = bufferToFloat32(row.embedding as Buffer);
      if (stored.length !== queryVec.length) continue;
      const sim = cosineSimilarity(queryVec, stored);
      scored.push({ memoryId: row.id, distance: 1 - sim });
    }

    scored.sort((a, b) => a.distance - b.distance);
    return scored.slice(0, limit);
  }

  async count(): Promise<number> {
    const rows = await this.db
      .select({ id: memoryEntries.id })
      .from(memoryEntries)
      .where(isNotNull(memoryEntries.embedding));
    return rows.length;
  }

  existingIds(): Set<string> {
    return new Set<string>();
  }

  async existingIdsAsync(): Promise<Set<string>> {
    const rows = await this.db
      .select({ id: memoryEntries.id })
      .from(memoryEntries)
      .where(isNotNull(memoryEntries.embedding));
    return new Set(rows.map((r) => r.id));
  }

  get provider(): EmbeddingPlugin {
    return this.plugin;
  }
}

function bufferToFloat32(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}
