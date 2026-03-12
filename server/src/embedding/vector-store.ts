import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import type { OrcaDrizzleDB } from '../db/connection';
import { memoryEntries } from '../db/schema';
import { log } from '../shared/logger';
import type { EmbeddingPlugin } from './types';

let UsearchIndex:
  | (new (opts: {
      metric: string;
      connectivity: number;
      dimensions: number;
      expansion_add?: number;
      expansion_search?: number;
    }) => HNSWIndex)
  | null = null;

interface HNSWIndex {
  add(key: bigint, vector: Float32Array): void;
  remove(key: bigint): void;
  search(
    vector: Float32Array,
    k: number,
  ): { keys: BigUint64Array; distances: Float32Array };
  size(): number;
}

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  UsearchIndex = require('usearch').Index;
} catch {
  // usearch unavailable — brute-force cosine fallback
}

const MIN_SIMILARITY = 0.2;

export class VectorStore {
  private hnswIndex: HNSWIndex | null = null;
  private keyToId = new Map<bigint, string>();
  private idToKey = new Map<string, bigint>();
  private nextKey = 0n;
  private indexBuilt = false;

  constructor(
    private readonly db: OrcaDrizzleDB,
    private readonly plugin: EmbeddingPlugin,
  ) {}

  async upsert(memoryId: string, text: string): Promise<void> {
    const vector = await this.plugin.embed(text);
    const buf = Buffer.from(
      vector.buffer,
      vector.byteOffset,
      vector.byteLength,
    );
    await this.db
      .update(memoryEntries)
      .set({ embedding: buf })
      .where(eq(memoryEntries.id, memoryId));
    if (this.indexBuilt) this.addToIndex(memoryId, vector);
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
      if (this.indexBuilt) this.addToIndex(entries[i]!.id, vec);
    }
  }

  async remove(memoryId: string): Promise<void> {
    await this.db
      .update(memoryEntries)
      .set({ embedding: null })
      .where(eq(memoryEntries.id, memoryId));
    this.removeFromIndex(memoryId);
  }

  invalidateIndex(): void {
    this.hnswIndex = null;
    this.keyToId.clear();
    this.idToKey.clear();
    this.nextKey = 0n;
    this.indexBuilt = false;
  }

  async search(
    query: string,
    limit: number,
  ): Promise<Array<{ memoryId: string; distance: number }>> {
    const queryVec = this.plugin.embedQuery
      ? await this.plugin.embedQuery(query)
      : await this.plugin.embed(query);

    if (UsearchIndex) return this.searchHNSW(queryVec, limit);
    return this.searchBruteForce(queryVec, limit);
  }

  async count(): Promise<number> {
    const rows = await this.db
      .select({ id: memoryEntries.id })
      .from(memoryEntries)
      .where(isNotNull(memoryEntries.embedding));
    return rows.length;
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

  // --- HNSW index via usearch ---

  private async searchHNSW(
    queryVec: Float32Array,
    limit: number,
  ): Promise<Array<{ memoryId: string; distance: number }>> {
    await this.ensureIndex(queryVec.length);
    if (!this.hnswIndex || this.keyToId.size === 0) return [];

    const k = Math.min(limit, this.keyToId.size);
    const results = this.hnswIndex.search(queryVec, k);
    const out: Array<{ memoryId: string; distance: number }> = [];
    for (let i = 0; i < results.keys.length; i++) {
      const distance = results.distances[i]!;
      if (1 - distance < MIN_SIMILARITY) continue;
      const memoryId = this.keyToId.get(results.keys[i]!);
      if (memoryId) out.push({ memoryId, distance });
    }
    return out;
  }

  private async ensureIndex(dims: number): Promise<void> {
    if (this.indexBuilt) return;

    const rows = await this.db
      .select({ id: memoryEntries.id, embedding: memoryEntries.embedding })
      .from(memoryEntries)
      .where(
        and(
          isNotNull(memoryEntries.embedding),
          isNull(memoryEntries.supersededBy),
        ),
      );

    this.hnswIndex = new UsearchIndex!({
      metric: 'cos',
      connectivity: 16,
      dimensions: dims,
    });
    this.keyToId.clear();
    this.idToKey.clear();
    this.nextKey = 0n;

    let loaded = 0;
    for (const row of rows) {
      if (!row.embedding) continue;
      const vec = bufferToFloat32(row.embedding as Buffer);
      if (vec.length !== dims) continue;
      this.addToIndex(row.id, vec);
      loaded++;
    }

    this.indexBuilt = true;
    log.info('HNSW index built', { entries: loaded, dimensions: dims });
  }

  private addToIndex(memoryId: string, vector: Float32Array): void {
    if (!this.hnswIndex) return;
    const existingKey = this.idToKey.get(memoryId);
    if (existingKey !== undefined) {
      try {
        this.hnswIndex.remove(existingKey);
      } catch {
        /* stale key */
      }
      this.keyToId.delete(existingKey);
    }
    const key = this.nextKey++;
    this.idToKey.set(memoryId, key);
    this.keyToId.set(key, memoryId);
    this.hnswIndex.add(key, vector);
  }

  private removeFromIndex(memoryId: string): void {
    if (!this.hnswIndex) return;
    const key = this.idToKey.get(memoryId);
    if (key === undefined) return;
    try {
      this.hnswIndex.remove(key);
    } catch {
      /* stale key */
    }
    this.keyToId.delete(key);
    this.idToKey.delete(memoryId);
  }

  // --- Brute-force fallback ---

  private async searchBruteForce(
    queryVec: Float32Array,
    limit: number,
  ): Promise<Array<{ memoryId: string; distance: number }>> {
    const rows = await this.db
      .select({ id: memoryEntries.id, embedding: memoryEntries.embedding })
      .from(memoryEntries)
      .where(
        and(
          isNotNull(memoryEntries.embedding),
          isNull(memoryEntries.supersededBy),
        ),
      );

    const scored: Array<{ memoryId: string; distance: number }> = [];
    for (const row of rows) {
      if (!row.embedding) continue;
      const stored = bufferToFloat32(row.embedding as Buffer);
      if (stored.length !== queryVec.length) continue;
      const sim = cosineSimilarity(queryVec, stored);
      if (sim < MIN_SIMILARITY) continue;
      scored.push({ memoryId: row.id, distance: 1 - sim });
    }

    scored.sort((a, b) => a.distance - b.distance);
    return scored.slice(0, limit);
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
