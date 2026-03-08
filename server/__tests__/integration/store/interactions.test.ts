import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseConnection } from '../../../src/db/connection';
import { InteractionStore } from '../../../src/store/interactions';
import { TaskStore } from '../../../src/store/tasks';
import { createTestDB } from '../../helpers/db';

let conn: DatabaseConnection;
let store: InteractionStore;
let tasks: TaskStore;
let tmpDir: string;

beforeEach(async () => {
  conn = createTestDB();
  tmpDir = await mkdtemp(join(tmpdir(), 'orca-test-'));
  store = new InteractionStore(conn.db, tmpDir);
  tasks = new TaskStore(conn.db);
});

afterEach(async () => {
  conn.close();
  await rm(tmpDir, { recursive: true, force: true });
});

/** Helper: create a task and return its id */
async function makeTask(title = 'test task'): Promise<string> {
  const t = await tasks.create({ title });
  return t.id;
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
    await store.finish(id, {
      status: 'failed',
      error: 'boom',
      diff: '+added\n-removed',
      exitCode: 1,
      durationMs: 500,
      inputTokens: 100,
      outputTokens: 50,
      estimatedCost: 0.01,
      runId: 'run-1',
      model: 'claude-4',
    });
    const ix = await store.get(id);
    expect(ix!.error).toBe('boom');
    expect(ix!.diff).toBe('+added\n-removed');
    expect(ix!.exitCode).toBe(1);
    expect(ix!.durationMs).toBe(500);
    expect(ix!.inputTokens).toBe(100);
    expect(ix!.outputTokens).toBe(50);
    expect(ix!.estimatedCost).toBe(0.01);
    expect(ix!.runId).toBe('run-1');
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
    expect(results[0].type).toBe('code');
  });
});

describe('listByStatus', () => {
  test('filters by status', async () => {
    const { id } = await store.begin({ type: 'code', tool: 'a' });
    await store.begin({ type: 'review', tool: 'b' });
    await store.finish(id, { status: 'completed' });
    const running = await store.listByStatus('running');
    expect(running).toHaveLength(1);
    expect(running[0].tool).toBe('b');
    const completed = await store.listByStatus('completed');
    expect(completed).toHaveLength(1);
    expect(completed[0].id).toBe(id);
  });
});

describe('listStubs', () => {
  test('returns lightweight stubs', async () => {
    const tid = await makeTask();
    await store.begin({ taskId: tid, type: 'code', tool: 'claude' });
    const stubs = await store.listStubs(tid);
    expect(stubs).toHaveLength(1);
    expect(stubs[0].id).toBeTruthy();
    expect(stubs[0].type).toBe('code');
    expect(stubs[0].tool).toBe('claude');
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

describe('projectTotal', () => {
  test('sums estimatedCost across all interactions', async () => {
    const { id: id1 } = await store.begin({ type: 'code', tool: 'a' });
    const { id: id2 } = await store.begin({ type: 'review', tool: 'b' });
    await store.finish(id1, { status: 'completed', estimatedCost: 0.05 });
    await store.finish(id2, { status: 'completed', estimatedCost: 0.1 });
    expect(await store.projectTotal()).toBeCloseTo(0.15);
  });

  test('returns 0 with no interactions', async () => {
    expect(await store.projectTotal()).toBe(0);
  });
});

describe('runTotal', () => {
  test('sums estimatedCost for a specific runId', async () => {
    const { id: id1 } = await store.begin({ type: 'code', tool: 'a' });
    const { id: id2 } = await store.begin({ type: 'review', tool: 'b' });
    const { id: id3 } = await store.begin({ type: 'code', tool: 'c' });
    await store.finish(id1, {
      status: 'completed',
      estimatedCost: 0.05,
      runId: 'run-1',
    });
    await store.finish(id2, {
      status: 'completed',
      estimatedCost: 0.1,
      runId: 'run-1',
    });
    await store.finish(id3, {
      status: 'completed',
      estimatedCost: 0.2,
      runId: 'run-2',
    });
    expect(await store.runTotal('run-1')).toBeCloseTo(0.15);
    expect(await store.runTotal('run-2')).toBeCloseTo(0.2);
  });
});

describe('runSummary', () => {
  test('groups by tool with token/cost sums', async () => {
    const { id: id1 } = await store.begin({ type: 'code', tool: 'claude' });
    const { id: id2 } = await store.begin({ type: 'review', tool: 'claude' });
    const { id: id3 } = await store.begin({ type: 'code', tool: 'grep' });
    await store.finish(id1, {
      status: 'completed',
      runId: 'r1',
      inputTokens: 100,
      outputTokens: 50,
      estimatedCost: 0.01,
    });
    await store.finish(id2, {
      status: 'completed',
      runId: 'r1',
      inputTokens: 200,
      outputTokens: 80,
      estimatedCost: 0.02,
    });
    await store.finish(id3, {
      status: 'completed',
      runId: 'r1',
      inputTokens: 10,
      outputTokens: 5,
      estimatedCost: 0.001,
    });
    const summary = await store.runSummary('r1');
    expect(summary).toHaveLength(2);
    const claude = summary.find((s) => s.tool === 'claude')!;
    expect(claude.inputTokens).toBe(300);
    expect(claude.outputTokens).toBe(130);
    expect(claude.cost).toBeCloseTo(0.03);
    const grep = summary.find((s) => s.tool === 'grep')!;
    expect(grep.inputTokens).toBe(10);
  });
});

describe('projectSummary', () => {
  test('groups by tool across all interactions', async () => {
    const { id: id1 } = await store.begin({ type: 'code', tool: 'claude' });
    const { id: id2 } = await store.begin({ type: 'review', tool: 'claude' });
    await store.finish(id1, {
      status: 'completed',
      inputTokens: 100,
      outputTokens: 50,
      estimatedCost: 0.01,
    });
    await store.finish(id2, {
      status: 'completed',
      inputTokens: 200,
      outputTokens: 80,
      estimatedCost: 0.02,
    });
    const summary = await store.projectSummary();
    expect(summary).toHaveLength(1);
    expect(summary[0].inputTokens).toBe(300);
    expect(summary[0].cost).toBeCloseTo(0.03);
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

describe('listRuns', () => {
  test('groups by runId with aggregated stats', async () => {
    const { id: id1 } = await store.begin({ type: 'code', tool: 'a' });
    const { id: id2 } = await store.begin({ type: 'review', tool: 'b' });
    await store.finish(id1, {
      status: 'completed',
      runId: 'run-1',
      inputTokens: 100,
      outputTokens: 50,
      estimatedCost: 0.05,
    });
    await store.finish(id2, {
      status: 'completed',
      runId: 'run-1',
      inputTokens: 200,
      outputTokens: 80,
      estimatedCost: 0.1,
    });
    const runs = await store.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0].runId).toBe('run-1');
    expect(runs[0].interactions).toBe(2);
    expect(runs[0].inputTokens).toBe(300);
    expect(runs[0].outputTokens).toBe(130);
    expect(runs[0].cost).toBeCloseTo(0.15);
  });

  test('excludes interactions without runId', async () => {
    const { id } = await store.begin({ type: 'code', tool: 'a' });
    await store.finish(id, { status: 'completed', estimatedCost: 0.05 });
    const runs = await store.listRuns();
    expect(runs).toHaveLength(0);
  });
});

describe('findRunIDsByPrefix', () => {
  test('finds run IDs matching prefix', async () => {
    const { id: id1 } = await store.begin({ type: 'code', tool: 'a' });
    const { id: id2 } = await store.begin({ type: 'review', tool: 'b' });
    await store.finish(id1, { status: 'completed', runId: 'run-abc-123' });
    await store.finish(id2, { status: 'completed', runId: 'run-xyz-456' });
    const matches = await store.findRunIDsByPrefix('run-abc');
    expect(matches).toEqual(['run-abc-123']);
  });

  test('returns empty for empty prefix', async () => {
    expect(await store.findRunIDsByPrefix('')).toEqual([]);
  });
});

describe('listOperations', () => {
  test('returns running interactions by default', async () => {
    const { id: id1 } = await store.begin({ type: 'code', tool: 'a' });
    await store.begin({ type: 'review', tool: 'b' });
    await store.finish(id1, { status: 'completed' });
    const ops = await store.listOperations();
    expect(ops).toHaveLength(1);
    expect(ops[0].status).toBe('running');
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
