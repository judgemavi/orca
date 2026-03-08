import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { TestContext } from '../../helpers/db';
import { createTestContext } from '../../helpers/db';

let ctx: TestContext;

beforeEach(() => {
  ctx = createTestContext();
});

afterEach(() => {
  ctx.close();
});

describe('ConfigStore', () => {
  test('load returns default config on fresh db', async () => {
    const config = await ctx.configStore.load();
    expect(config).toBeTruthy();
    expect(config.workers).toBeTruthy();
    expect(config.interactions).toBeTruthy();
  });

  test('save and load roundtrip', async () => {
    const config = await ctx.configStore.load();
    config.workers.maxParallel = 5;
    await ctx.configStore.save(config);

    const loaded = await ctx.configStore.load();
    expect(loaded.workers.maxParallel).toBe(5);
  });

  test('patch merges partial config', async () => {
    const patched = await ctx.configStore.patch({
      workers: { maxParallel: 10 },
    });
    expect(patched.workers.maxParallel).toBe(10);

    // Other fields still present
    expect(patched.interactions).toBeTruthy();
  });
});
