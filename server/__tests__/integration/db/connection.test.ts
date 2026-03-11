import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../../src/db/connection';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('openDatabase', () => {
  test('creates missing parent directories for the default repo db path', async () => {
    const repoDir = await mkdtemp(join(tmpdir(), 'orca-db-'));
    tempDirs.push(repoDir);

    const conn = openDatabase({ repoDir });
    conn.close();

    expect(await Bun.file(join(repoDir, '.orca', 'state.db')).exists()).toBe(
      true,
    );
  });
});
