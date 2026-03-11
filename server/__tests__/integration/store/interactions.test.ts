import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OrcaDrizzleDB } from '../../../src/db/connection';
import { InteractionStore } from '../../../src/store/interactions';
import { createTask } from '../../../src/store/tasks';
import { createTestDB } from '../../helpers/db';

let db: OrcaDrizzleDB;
let closeFn: () => void;
let store: InteractionStore;
let tmpDir: string;

beforeEach(async () => {
  const conn = createTestDB();
  db = conn.db;
  closeFn = conn.close;
  tmpDir = await mkdtemp(join(tmpdir(), 'orca-test-'));
  store = new InteractionStore(db, tmpDir);
});

afterEach(async () => {
  closeFn();
  await rm(tmpDir, { recursive: true, force: true });
});

/** Helper: create a task and return its id */
async function makeTask(title = 'test task'): Promise<string> {
  const id = `task-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await createTask(db, undefined, { id, title });
  return id;
}

describe('begin', () => {
  test('creates interaction and returns id, attempt, logPath', async () => {
    const result = await store.begin({ type: 'code', tool: 'claude' });
    expect(result.id).toBeTruthy();
    expect(result.attempt).toBe(1);
    expect(result.logPath).toContain(tmpDir);
    expect(result.logPath).toContain('code-1-');
  });

  test('throws on empty type', async () => {
    await expect(store.begin({ type: '', tool: 'claude' })).rejects.toThrow(
      'type required',
    );
  });

  test('throws on empty tool', async () => {
    await expect(store.begin({ type: 'code', tool: '' })).rejects.toThrow(
      'tool required',
    );
  });

  test('auto-increments attempt for same taskId+type', async () => {
    const tid = await makeTask();
    const r1 = await store.begin({ taskId: tid, type: 'code', tool: 'claude' });
    const r2 = await store.begin({ taskId: tid, type: 'code', tool: 'claude' });
    expect(r1.attempt).toBe(1);
    expect(r2.attempt).toBe(2);
  });

  test('attempt resets for different type', async () => {
    const tid = await makeTask();
    await store.begin({ taskId: tid, type: 'code', tool: 'claude' });
    const r2 = await store.begin({
      taskId: tid,
      type: 'review',
      tool: 'claude',
    });
    expect(r2.attempt).toBe(1);
  });
});

describe('get', () => {
  test('returns interaction by id', async () => {
    const tid = await makeTask();
    const { id } = await store.begin({
      taskId: tid,
      type: 'code',
      tool: 'claude',
    });
    const ix = await store.get(id);
    expect(ix).not.toBeNull();
    expect(ix!.id).toBe(id);
    expect(ix!.type).toBe('code');
    expect(ix!.tool).toBe('claude');
    expect(ix!.status).toBe('running');
    expect(ix!.taskId).toBe(tid);
  });

  test('returns null for missing id', async () => {
    expect(await store.get('nonexistent')).toBeNull();
  });
});

describe('finish', () => {
  test('updates status and finishedAt', async () => {
    const { id } = await store.begin({ type: 'code', tool: 'claude' });
    await store.finish(id, { status: 'completed' });
    const ix = await store.get(id);
    expect(ix!.status).toBe('completed');
    expect(ix!.finishedAt).toBeTruthy();
  });

  test('sets optional fields', async () => {
    const { id } = await store.begin({ type: 'code', tool: 'claude' });
    const outputJson = JSON.stringify({ result: 'success', data: { diff: '+added\n-removed' } });
    await store.finish(id, {
      status: 'failed',
      error: 'boom',
      output: outputJson,
      exitCode: 1,
      durationMs: 500,
      model: 'claude-4',
    });
    const ix = await store.get(id);
    expect(ix!.error).toBe('boom');
    expect(ix!.output).toBe(outputJson);
    expect(ix!.exitCode).toBe(1);
    expect(ix!.durationMs).toBe(500);
    expect(ix!.model).toBe('claude-4');
  });

  test('throws for missing interaction', async () => {
    await expect(store.finish('nope', { status: 'completed' })).rejects.toThrow(
      'not found',
    );
  });
});

describe('list', () => {
  test('lists interactions for a taskId ordered by startedAt desc', async () => {
    const tid = await makeTask();
    await store.begin({ taskId: tid, type: 'code', tool: 'a' });
    await store.begin({ taskId: tid, type: 'review', tool: 'b' });
    const tid2 = await makeTask('other');
    await store.begin({ taskId: tid2, type: 'code', tool: 'c' });
    const results = await store.list(tid);
    expect(results).toHaveLength(2);
    expect(new Set(results.map((r) => r.tool))).toEqual(new Set(['a', 'b']));
  });
});

describe('listByType', () => {
  test('filters by type', async () => {
    const tid = await makeTask();
    await store.begin({ taskId: tid, type: 'code', tool: 'a' });
    await store.begin({ taskId: tid, type: 'review', tool: 'b' });
    const results = await store.listByType(tid, 'code');
    expect(results).toHaveLength(1);
    expect(results[0]!.type).toBe('code');
  });
});

describe('listByStatus', () => {
  test('filters by status', async () => {
    const { id } = await store.begin({ type: 'code', tool: 'a' });
    await store.begin({ type: 'review', tool: 'b' });
    await store.finish(id, { status: 'completed' });
    const running = await store.listByStatus('running');
    expect(running).toHaveLength(1);
    expect(running[0]!.tool).toBe('b');
    const completed = await store.listByStatus('completed');
    expect(completed).toHaveLength(1);
    expect(completed[0]!.id).toBe(id);
  });
});

describe('listStubs', () => {
  test('returns lightweight stubs', async () => {
    const tid = await makeTask();
    await store.begin({ taskId: tid, type: 'code', tool: 'claude' });
    const stubs = await store.listStubs(tid);
    expect(stubs).toHaveLength(1);
    expect(stubs[0]!.id).toBeTruthy();
    expect(stubs[0]!.type).toBe('code');
    expect(stubs[0]!.tool).toBe('claude');
    expect((stubs[0] as any).logPath).toBeUndefined();
  });
});

describe('isRunning', () => {
  test('returns true when running interaction exists', async () => {
    const tid = await makeTask();
    await store.begin({ taskId: tid, type: 'code', tool: 'claude' });
    expect(await store.isRunning(tid, 'code')).toBe(true);
  });

  test('returns false after finishing', async () => {
    const tid = await makeTask();
    const { id } = await store.begin({
      taskId: tid,
      type: 'code',
      tool: 'claude',
    });
    await store.finish(id, { status: 'completed' });
    expect(await store.isRunning(tid, 'code')).toBe(false);
  });

  test('returns false for different type', async () => {
    const tid = await makeTask();
    await store.begin({ taskId: tid, type: 'code', tool: 'claude' });
    expect(await store.isRunning(tid, 'review')).toBe(false);
  });
});

describe('markStaleAsFailed', () => {
  test('marks all running interactions as failed', async () => {
    const { id: id1 } = await store.begin({ type: 'code', tool: 'a' });
    const { id: id2 } = await store.begin({ type: 'review', tool: 'b' });
    await store.finish(id1, { status: 'completed' });
    // id2 still running
    await store.markStaleAsFailed();
    const ix1 = await store.get(id1);
    const ix2 = await store.get(id2);
    expect(ix1!.status).toBe('completed');
    expect(ix2!.status).toBe('failed');
    expect(ix2!.error).toContain('server restarted');
    expect(ix2!.finishedAt).toBeTruthy();
  });
});

describe('listOperations', () => {
  test('returns running interactions by default', async () => {
    const { id: id1 } = await store.begin({ type: 'code', tool: 'a' });
    await store.begin({ type: 'review', tool: 'b' });
    await store.finish(id1, { status: 'completed' });
    const ops = await store.listOperations();
    expect(ops).toHaveLength(1);
    expect(ops[0]!.status).toBe('running');
  });

  test('returns all with all flag', async () => {
    await store.begin({ type: 'code', tool: 'a' });
    const { id } = await store.begin({ type: 'review', tool: 'b' });
    await store.finish(id, { status: 'completed' });
    const ops = await store.listOperations({ all: true });
    expect(ops).toHaveLength(2);
  });
});

describe('appendRawOutput + readLog', () => {
  test('appends text to log file and reads it back', async () => {
    const { id } = await store.begin({ type: 'code', tool: 'claude' });
    await store.appendRawOutput(id, 'line one');
    await store.appendRawOutput(id, 'line two\n');
    const content = await store.readLog(id);
    expect(content).toBe('line one\nline two\n');
  });

  test('readLog throws for missing interaction', async () => {
    await expect(store.readLog('nope')).rejects.toThrow('not found');
  });

  test('appendRawOutput throws for missing interaction', async () => {
    await expect(store.appendRawOutput('nope', 'text')).rejects.toThrow(
      'not found',
    );
  });
});
