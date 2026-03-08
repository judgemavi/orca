import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { DatabaseConnection } from '../../../src/db/connection';
import { taskInteractions, tasks } from '../../../src/db/schema';
import { MemoryStore } from '../../../src/store/memory';
import type { MemoryEntryInput } from '../../../src/store/types';
import { createTestDB } from '../../helpers/db';

let conn: DatabaseConnection;
let store: MemoryStore;

function entry(overrides: Partial<MemoryEntryInput> = {}): MemoryEntryInput {
  return {
    content: 'test content',
    category: 'architecture',
    provenanceHash: `hash-${Date.now()}-${Math.random()}`,
    ...overrides,
  };
}

beforeEach(() => {
  conn = createTestDB();
  store = new MemoryStore(conn.db);
});

afterEach(() => {
  conn.close();
});

describe('MemoryStore', () => {
  // 1. create + get
  test('create + get returns all fields', async () => {
    const e = await store.create(
      entry({
        content: 'arch decision',
        category: 'architecture',
        tags: ['db', 'migration'],
        sourceType: 'retro',
        confidence: 0.9,
        coveredAtCommit: 'abc123',
        stale: false,
        decayExempt: true,
      }),
    );

    expect(e.id).toBeTruthy();
    expect(e.content).toBe('arch decision');
    expect(e.category).toBe('architecture');
    expect(e.tags).toEqual(['db', 'migration']);
    expect(e.sourceType).toBe('retro');
    expect(e.confidence).toBe(0.9);
    expect(e.coveredAtCommit).toBe('abc123');
    expect(e.stale).toBe(false);
    expect(e.decayExempt).toBe(true);
    expect(e.createdAt).toBeTruthy();
    expect(e.updatedAt).toBeTruthy();

    const got = await store.get(e.id);
    expect(got).not.toBeNull();
    expect(got!.content).toBe('arch decision');
  });

  // 2. create validation
  test('create throws on empty content', async () => {
    await expect(store.create(entry({ content: '' }))).rejects.toThrow(
      'content required',
    );
  });

  test('create throws on empty category', async () => {
    await expect(store.create(entry({ category: '' as any }))).rejects.toThrow(
      'category required',
    );
  });

  test('create throws on empty provenanceHash', async () => {
    await expect(store.create(entry({ provenanceHash: '' }))).rejects.toThrow(
      'provenanceHash required',
    );
  });

  // 3. create with filePaths
  test('create with filePaths stores associations', async () => {
    const e = await store.create(
      entry({ filePaths: ['src/a.ts', 'src/b.ts'] }),
    );
    const paths = await store.getFilePaths(e.id);
    expect(paths).toEqual(['src/a.ts', 'src/b.ts']);
    expect(e.filePaths).toEqual(['src/a.ts', 'src/b.ts']);
  });

  // 4. list returns non-superseded
  test('list returns non-superseded entries', async () => {
    const e1 = await store.create(entry());
    const e2 = await store.create(entry());
    await store.supersede(e1.id, e2.id);

    const all = await store.list();
    expect(all.map((e) => e.id)).toContain(e2.id);
    expect(all.map((e) => e.id)).not.toContain(e1.id);
  });

  // 5. list with category filter
  test('list filters by category', async () => {
    await store.create(entry({ category: 'architecture' }));
    await store.create(entry({ category: 'tooling' as any }));

    const filtered = await store.list({ category: 'architecture' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].category).toBe('architecture');
  });

  // 6. list with tag filter
  test('list filters by tag', async () => {
    await store.create(entry({ tags: ['db'] }));
    await store.create(entry({ tags: ['api'] }));

    const filtered = await store.list({ tag: 'db' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].tags).toContain('db');
  });

  // 7. list with sourceType filter
  test('list filters by sourceType', async () => {
    await store.create(entry({ sourceType: 'retro' }));
    await store.create(entry({ sourceType: 'explore' }));

    const filtered = await store.list({ sourceType: 'explore' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].sourceType).toBe('explore');
  });

  // 8. list with filePath filter
  test('list filters by filePath', async () => {
    await store.create(entry({ filePaths: ['src/a.ts'] }));
    await store.create(entry({ filePaths: ['src/b.ts'] }));

    const filtered = await store.list({ filePath: 'src/a.ts' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].filePaths).toContain('src/a.ts');
  });

  // 9. list with staleOnly filter
  test('list filters staleOnly', async () => {
    const e1 = await store.create(entry());
    await store.create(entry());
    await store.markStale(e1.id);

    const filtered = await store.list({ staleOnly: true });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe(e1.id);
  });

  // 10. update
  test('update modifies fields', async () => {
    const e = await store.create(entry({ confidence: 0.5 }));
    await store.update(e.id, {
      content: 'updated',
      category: 'tooling' as any,
      confidence: 0.8,
      tags: ['new-tag'],
    });

    const got = await store.get(e.id);
    expect(got!.content).toBe('updated');
    expect(got!.category).toBe('tooling');
    expect(got!.confidence).toBe(0.8);
    expect(got!.tags).toEqual(['new-tag']);
  });

  // 11. update missing entry throws
  test('update missing entry throws', async () => {
    await expect(store.update('nonexistent', { content: 'x' })).rejects.toThrow(
      'not found',
    );
  });

  // 12. update with empty fields is no-op
  test('update with empty fields is no-op', async () => {
    const e = await store.create(entry({ content: 'original' }));
    await store.update(e.id, {});
    const got = await store.get(e.id);
    expect(got!.content).toBe('original');
  });

  // 13. delete
  test('delete removes entry', async () => {
    const e = await store.create(entry());
    await store.delete(e.id);
    const got = await store.get(e.id);
    expect(got).toBeNull();
  });

  // 14. delete missing throws
  test('delete missing entry throws', async () => {
    await expect(store.delete('nonexistent')).rejects.toThrow('not found');
  });

  // 15. getByProvenanceHash
  test('getByProvenanceHash finds entry', async () => {
    const e = await store.create(entry({ provenanceHash: 'unique-hash' }));
    const got = await store.getByProvenanceHash('unique-hash');
    expect(got).not.toBeNull();
    expect(got!.id).toBe(e.id);
  });

  // 16. hasProvenanceHash
  test('hasProvenanceHash returns boolean', async () => {
    await store.create(entry({ provenanceHash: 'exists-hash' }));
    expect(await store.hasProvenanceHash('exists-hash')).toBe(true);
    expect(await store.hasProvenanceHash('nope')).toBe(false);
  });

  // 17. supersede
  test('supersede marks old entry and list excludes it', async () => {
    const old = await store.create(entry());
    const newer = await store.create(entry());
    await store.supersede(old.id, newer.id);

    const got = await store.get(old.id);
    expect(got!.supersededBy).toBe(newer.id);

    const all = await store.list();
    expect(all.map((e) => e.id)).not.toContain(old.id);
  });

  // 18. boostConfidence
  test('boostConfidence increases confidence capped at 1.0', async () => {
    const e = await store.create(entry({ confidence: 0.8 }));
    await store.boostConfidence(e.id, 2.0);
    const got = await store.get(e.id);
    expect(got!.confidence).toBe(1.0);
  });

  // 19. decayEntry
  test('decayEntry decreases confidence with floor 0.1', async () => {
    const e = await store.create(entry({ confidence: 0.2 }));
    await store.decayEntry(e.id, 0.1);
    const got = await store.get(e.id);
    expect(got!.confidence).toBe(0.1);
  });

  // 20. markStale
  test('markStale sets stale flag', async () => {
    const e = await store.create(entry());
    expect(e.stale).toBe(false);
    await store.markStale(e.id);
    const got = await store.get(e.id);
    expect(got!.stale).toBe(true);
  });

  // 21. updateCoveredCommit
  test('updateCoveredCommit updates commit SHA', async () => {
    const e = await store.create(entry());
    await store.updateCoveredCommit(e.id, 'deadbeef');
    const got = await store.get(e.id);
    expect(got!.coveredAtCommit).toBe('deadbeef');
  });

  // 22. associateFiles
  test('associateFiles adds file associations', async () => {
    const e = await store.create(entry());
    await store.associateFiles(e.id, ['src/c.ts', 'src/d.ts']);
    const paths = await store.getFilePaths(e.id);
    expect(paths).toEqual(['src/c.ts', 'src/d.ts']);
  });

  // 23. renameFilePathAssociations
  test('renameFilePathAssociations renames paths', async () => {
    const e = await store.create(entry({ filePaths: ['old/path.ts'] }));
    const count = await store.renameFilePathAssociations(
      'old/path.ts',
      'new/path.ts',
    );
    expect(count).toBe(1);
    const paths = await store.getFilePaths(e.id);
    expect(paths).toEqual(['new/path.ts']);
  });

  // 24. findByFilePaths
  test('findByFilePaths finds entries by file paths', async () => {
    await store.create(entry({ filePaths: ['src/x.ts'] }));
    await store.create(entry({ filePaths: ['src/y.ts'] }));

    const found = await store.findByFilePaths(['src/x.ts']);
    expect(found).toHaveLength(1);
    expect(found[0].filePaths).toContain('src/x.ts');
  });

  // 25. findByInteractionId
  test('findByInteractionId finds entries', async () => {
    // Seed FK parents: task + interactions
    await conn.db.insert(tasks).values({ id: 'task-fk', title: 'fk task' });
    await conn.db.insert(taskInteractions).values([
      {
        id: 'int-99',
        taskId: 'task-fk',
        type: 'run',
        tool: 'test',
        logPath: '/dev/null',
        status: 'completed',
      },
      {
        id: 'int-100',
        taskId: 'task-fk',
        type: 'run',
        tool: 'test',
        logPath: '/dev/null',
        status: 'completed',
      },
    ]);

    await store.create(entry({ sourceInteractionId: 'int-99' }));
    await store.create(entry({ sourceInteractionId: 'int-100' }));

    const found = await store.findByInteractionId('int-99');
    expect(found).toHaveLength(1);
    expect(found[0].sourceInteractionId).toBe('int-99');
  });

  // 26. findStaleEntries
  test('findStaleEntries returns stale non-superseded entries', async () => {
    const e1 = await store.create(entry());
    const e2 = await store.create(entry());
    const e3 = await store.create(entry());
    await store.markStale(e1.id);
    await store.markStale(e2.id);
    await store.supersede(e2.id, e3.id);

    const stale = await store.findStaleEntries();
    expect(stale).toHaveLength(1);
    expect(stale[0].id).toBe(e1.id);
  });

  // 27. findSupersededIDs
  test('findSupersededIDs returns IDs superseded by given ID', async () => {
    const old1 = await store.create(entry());
    const old2 = await store.create(entry());
    const newer = await store.create(entry());
    await store.supersede(old1.id, newer.id);
    await store.supersede(old2.id, newer.id);

    const ids = await store.findSupersededIDs(newer.id);
    expect(ids).toHaveLength(2);
    expect(ids).toContain(old1.id);
    expect(ids).toContain(old2.id);
  });

  // 28. buildHealthSummary
  test('buildHealthSummary returns correct counts', async () => {
    await store.create(entry({ sourceType: 'retro' }));
    await store.create(entry({ sourceType: 'retro' }));
    await store.create(entry({ sourceType: 'explore' }));
    const e4 = await store.create(entry({ sourceType: 'retro' }));
    await store.markStale(e4.id);

    const summary = await store.buildHealthSummary();
    expect(summary.totalEntries).toBe(4);
    expect(summary.bySource.retro).toBe(3);
    expect(summary.bySource.explore).toBe(1);
    expect(summary.staleCount).toBe(1);
    expect(summary.avgConfidence).toBeGreaterThan(0);
  });

  // 29. bumpRetrievalCount
  test('bumpRetrievalCount increments count', async () => {
    const e = await store.create(entry());
    expect(e.retrievalCount).toBe(0);

    await store.bumpRetrievalCount([e.id]);
    await store.bumpRetrievalCount([e.id]);

    const got = await store.get(e.id);
    expect(got!.retrievalCount).toBe(2);
  });

  // 30. getMeta / setMeta
  test('getMeta returns empty string for missing key', async () => {
    expect(await store.getMeta('nonexistent')).toBe('');
  });

  test('setMeta + getMeta roundtrip', async () => {
    await store.setMeta('last-sync', '2024-01-01');
    expect(await store.getMeta('last-sync')).toBe('2024-01-01');
  });

  test('setMeta overwrites existing key', async () => {
    await store.setMeta('key', 'v1');
    await store.setMeta('key', 'v2');
    expect(await store.getMeta('key')).toBe('v2');
  });

  // 31. decayConfidence
  test('decayConfidence bulk decays old entries, respects decayExempt', async () => {
    // Create entries — they'll have CURRENT_TIMESTAMP as updatedAt.
    // decayConfidence needs entries older than the threshold.
    // We set a very small olderThanMs (1ms) and wait briefly.
    const normal = await store.create(entry({ confidence: 1.0 }));
    const exempt = await store.create(
      entry({ confidence: 1.0, decayExempt: true }),
    );

    // Small delay to ensure entries are "old enough" relative to 1ms threshold
    await new Promise((r) => setTimeout(r, 50));

    const decayed = await store.decayConfidence(1, 0.5);

    const gotNormal = await store.get(normal.id);
    const gotExempt = await store.get(exempt.id);

    // Normal entry should have been decayed
    expect(gotNormal!.confidence).toBeLessThan(1.0);
    // Exempt entry should remain untouched
    expect(gotExempt!.confidence).toBe(1.0);
    expect(decayed).toBeGreaterThanOrEqual(1);
  });
});
