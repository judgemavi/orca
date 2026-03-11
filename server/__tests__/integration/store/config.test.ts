import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { OrcaDrizzleDB } from '../../../src/db/connection';
import {
  loadConfig,
  patchConfig,
  saveConfig,
} from '../../../src/store/config';
import { createTestDB } from '../../helpers/db';

let db: OrcaDrizzleDB;
let closeFn: () => void;

beforeEach(() => {
  const conn = createTestDB();
  db = conn.db;
  closeFn = conn.close;
});

afterEach(() => {
  closeFn();
});

describe('ConfigStore', () => {
  test('save and load roundtrip', async () => {
    const config = await loadConfig(db);
    config.workers.maxParallel = 5;
    await saveConfig(db, undefined, config);

    const loaded = await loadConfig(db);
    expect(loaded.workers.maxParallel).toBe(5);
  });

  test('patch merges partial config', async () => {
    await patchConfig(db, undefined, {
      workers: { maxParallel: 10 },
    });

    const patched = await loadConfig(db);
    expect(patched.workers.maxParallel).toBe(10);

    // Other fields still present
    expect(patched.orchestrator).toBeTruthy();
  });
});
