import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { resumeChain, unblockDependents } from '../../../src/queue/chain';
import type { TestContext } from '../../helpers/db';
import { createTestContext } from '../../helpers/db';

let ctx: TestContext;

beforeEach(async () => {
  ctx = createTestContext();
  await ctx.configStore.patch({
    interactions: {
      evaluate: { tool: 'claude', model: 'test', autoRun: true },
      plan: { tool: 'claude', model: 'test', autoRun: true },
      code: { tool: 'claude', model: 'test', autoRun: true },
      review: { tool: 'claude', model: 'test', autoRun: true },
      merge: { tool: 'claude', model: 'test', autoRun: true },
      retro: { tool: 'claude', model: 'test', autoRun: true },
      breakdown: { tool: 'claude', model: 'test', autoRun: true },
    },
  });
});

afterEach(() => {
  ctx.close();
});

// ---------------------------------------------------------------------------
// resumeChain edge cases
// ---------------------------------------------------------------------------

describe('resumeChain edge cases', () => {
  test('nonexistent taskId — does not throw, still enqueues', async () => {
    // task is null but isAutoRun treats undefined overrides as no override,
    // and areDependenciesMet returns true (no dep rows). So a job IS enqueued.
    // Documenting: the chain module does NOT verify task existence.
    await resumeChain('nonexistent-id-000', 'planned', {
      configStore: ctx.configStore,
      taskStore: ctx.taskStore,
      queue: ctx.queue,
    });

    const jobs = await ctx.queue.list();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.type).toBe('code');
    expect(jobs[0]!.taskId).toBe('nonexistent-id-000');
  });

  test('empty taskId string — does not throw, still enqueues', async () => {
    // Same reasoning: no deps to block, autoRun defaults apply.
    await resumeChain('', 'planned', {
      configStore: ctx.configStore,
      taskStore: ctx.taskStore,
      queue: ctx.queue,
    });

    const jobs = await ctx.queue.list();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.taskId).toBe('');
  });

  test('calling resumeChain twice for same task/status double-enqueues', async () => {
    // resumeChain is stateless — it does NOT deduplicate.
    // Documenting: callers are responsible for not invoking it multiple times.
    const task = await ctx.taskStore.create({ title: 'Double' });

    const deps = {
      configStore: ctx.configStore,
      taskStore: ctx.taskStore,
      queue: ctx.queue,
    };

    await resumeChain(task.id, 'planned', deps);
    await resumeChain(task.id, 'planned', deps);

    const jobs = await ctx.queue.list({ taskId: task.id });
    // Two separate code jobs — no dedup
    expect(jobs).toHaveLength(2);
    expect(jobs.every((j) => j.type === 'code')).toBe(true);
  });

  test.each([
    'review' as const,
    'running' as const,
    'failed' as const,
    'merged' as const,
    'broken_down' as const,
    'stopped' as const,
  ])('status "%s" does not enqueue any job', async (status) => {
    const task = await ctx.taskStore.create({ title: `S-${status}` });

    await resumeChain(task.id, status, {
      configStore: ctx.configStore,
      taskStore: ctx.taskStore,
      queue: ctx.queue,
    });

    const jobs = await ctx.queue.list({ taskId: task.id });
    expect(jobs).toHaveLength(0);
  });

  test('task with multiple deps, only some met — no enqueue', async () => {
    const dep1 = await ctx.taskStore.create({ title: 'Dep1' });
    const dep2 = await ctx.taskStore.create({ title: 'Dep2' });
    const task = await ctx.taskStore.create({ title: 'Blocked' });

    await ctx.taskStore.updateDependencies(task.id, [dep1.id, dep2.id]);
    // Only dep1 merged
    await ctx.taskStore.update(dep1.id, { status: 'merged' });

    await resumeChain(task.id, 'planned', {
      configStore: ctx.configStore,
      taskStore: ctx.taskStore,
      queue: ctx.queue,
    });

    const jobs = await ctx.queue.list({ taskId: task.id });
    expect(jobs).toHaveLength(0);
  });

  test('task with all deps met — enqueues', async () => {
    const dep1 = await ctx.taskStore.create({ title: 'Dep1' });
    const dep2 = await ctx.taskStore.create({ title: 'Dep2' });
    const task = await ctx.taskStore.create({ title: 'Ready' });

    await ctx.taskStore.updateDependencies(task.id, [dep1.id, dep2.id]);
    await ctx.taskStore.update(dep1.id, { status: 'merged' });
    await ctx.taskStore.update(dep2.id, { status: 'merged' });

    await resumeChain(task.id, 'planned', {
      configStore: ctx.configStore,
      taskStore: ctx.taskStore,
      queue: ctx.queue,
    });

    const jobs = await ctx.queue.list({ taskId: task.id });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.type).toBe('code');
  });

  test('self-dependency is rejected by updateDependencies', async () => {
    const task = await ctx.taskStore.create({ title: 'Self' });

    // updateDependencies runs cycle detection — self-dep is a cycle
    expect(
      ctx.taskStore.updateDependencies(task.id, [task.id]),
    ).rejects.toThrow(/circular dependency/);
  });
});

// ---------------------------------------------------------------------------
// unblockDependents complex scenarios
// ---------------------------------------------------------------------------

describe('unblockDependents complex scenarios', () => {
  test('diamond dependency: A merges — B,C unblock but D stays blocked', async () => {
    // A → B, A → C, B → D, C → D
    const a = await ctx.taskStore.create({ title: 'A' });
    const b = await ctx.taskStore.create({ title: 'B' });
    const c = await ctx.taskStore.create({ title: 'C' });
    const d = await ctx.taskStore.create({ title: 'D' });

    await ctx.taskStore.addDependency(b.id, a.id);
    await ctx.taskStore.addDependency(c.id, a.id);
    await ctx.taskStore.updateDependencies(d.id, [b.id, c.id]);

    await ctx.taskStore.update(a.id, { status: 'merged' });

    await unblockDependents(a.id, {
      configStore: ctx.configStore,
      taskStore: ctx.taskStore,
      queue: ctx.queue,
    });

    // B and C should each get an evaluate job
    const bJobs = await ctx.queue.list({ taskId: b.id });
    const cJobs = await ctx.queue.list({ taskId: c.id });
    const dJobs = await ctx.queue.list({ taskId: d.id });

    expect(bJobs).toHaveLength(1);
    expect(bJobs[0]!.type).toBe('evaluate');
    expect(cJobs).toHaveLength(1);
    expect(cJobs[0]!.type).toBe('evaluate');
    // D still blocked by B and C (not merged)
    expect(dJobs).toHaveLength(0);
  });

  test('chain of deps: A→B→C — only B unblocks when A merges', async () => {
    const a = await ctx.taskStore.create({ title: 'A' });
    const b = await ctx.taskStore.create({ title: 'B' });
    const c = await ctx.taskStore.create({ title: 'C' });

    await ctx.taskStore.addDependency(b.id, a.id);
    await ctx.taskStore.addDependency(c.id, b.id);

    await ctx.taskStore.update(a.id, { status: 'merged' });

    await unblockDependents(a.id, {
      configStore: ctx.configStore,
      taskStore: ctx.taskStore,
      queue: ctx.queue,
    });

    const bJobs = await ctx.queue.list({ taskId: b.id });
    const cJobs = await ctx.queue.list({ taskId: c.id });

    expect(bJobs).toHaveLength(1);
    expect(bJobs[0]!.type).toBe('evaluate');
    // C still blocked by B
    expect(cJobs).toHaveLength(0);
  });

  test('multiple tasks unblocked simultaneously — all get jobs', async () => {
    const dep = await ctx.taskStore.create({ title: 'Dep' });
    const t1 = await ctx.taskStore.create({ title: 'T1' });
    const t2 = await ctx.taskStore.create({ title: 'T2' });
    const t3 = await ctx.taskStore.create({ title: 'T3' });

    await ctx.taskStore.addDependency(t1.id, dep.id);
    await ctx.taskStore.addDependency(t2.id, dep.id);
    await ctx.taskStore.addDependency(t3.id, dep.id);

    await ctx.taskStore.update(dep.id, { status: 'merged' });

    await unblockDependents(dep.id, {
      configStore: ctx.configStore,
      taskStore: ctx.taskStore,
      queue: ctx.queue,
    });

    const allJobs = await ctx.queue.list();
    expect(allJobs).toHaveLength(3);
    expect(allJobs.every((j) => j.type === 'evaluate')).toBe(true);

    const taskIds = new Set(allJobs.map((j) => j.taskId));
    expect(taskIds.has(t1.id)).toBe(true);
    expect(taskIds.has(t2.id)).toBe(true);
    expect(taskIds.has(t3.id)).toBe(true);
  });

  test('dependent in running status — NOT re-enqueued', async () => {
    const a = await ctx.taskStore.create({ title: 'A' });
    const b = await ctx.taskStore.create({ title: 'B' });

    await ctx.taskStore.addDependency(b.id, a.id);
    // Force B to running — getUnblockedDependents only returns pending/planned
    await ctx.taskStore.update(b.id, { status: 'running' });
    await ctx.taskStore.update(a.id, { status: 'merged' });

    await unblockDependents(a.id, {
      configStore: ctx.configStore,
      taskStore: ctx.taskStore,
      queue: ctx.queue,
    });

    const jobs = await ctx.queue.list({ taskId: b.id });
    expect(jobs).toHaveLength(0);
  });

  test('dependent in failed status — NOT re-enqueued', async () => {
    const a = await ctx.taskStore.create({ title: 'A' });
    const b = await ctx.taskStore.create({ title: 'B' });

    await ctx.taskStore.addDependency(b.id, a.id);
    await ctx.taskStore.update(b.id, { status: 'failed' });
    await ctx.taskStore.update(a.id, { status: 'merged' });

    await unblockDependents(a.id, {
      configStore: ctx.configStore,
      taskStore: ctx.taskStore,
      queue: ctx.queue,
    });

    const jobs = await ctx.queue.list({ taskId: b.id });
    expect(jobs).toHaveLength(0);
  });

  test('dependent in merged status — NOT re-enqueued', async () => {
    const a = await ctx.taskStore.create({ title: 'A' });
    const b = await ctx.taskStore.create({ title: 'B' });

    await ctx.taskStore.addDependency(b.id, a.id);
    await ctx.taskStore.update(b.id, { status: 'merged' });
    await ctx.taskStore.update(a.id, { status: 'merged' });

    await unblockDependents(a.id, {
      configStore: ctx.configStore,
      taskStore: ctx.taskStore,
      queue: ctx.queue,
    });

    const jobs = await ctx.queue.list({ taskId: b.id });
    expect(jobs).toHaveLength(0);
  });

  test('autoRunOverrides disabling evaluate — dependent skipped', async () => {
    const a = await ctx.taskStore.create({ title: 'A' });
    const b = await ctx.taskStore.create({
      title: 'B',
      autoRunOverrides: { evaluate: false },
    });

    await ctx.taskStore.addDependency(b.id, a.id);
    await ctx.taskStore.update(a.id, { status: 'merged' });

    await unblockDependents(a.id, {
      configStore: ctx.configStore,
      taskStore: ctx.taskStore,
      queue: ctx.queue,
    });

    const jobs = await ctx.queue.list({ taskId: b.id });
    expect(jobs).toHaveLength(0);
  });

  test('autoRunOverrides disabling code — planned dependent skipped', async () => {
    const a = await ctx.taskStore.create({ title: 'A' });
    const b = await ctx.taskStore.create({
      title: 'B',
      autoRunOverrides: { code: false },
    });

    await ctx.taskStore.addDependency(b.id, a.id);
    await ctx.taskStore.update(b.id, { status: 'planned' });
    await ctx.taskStore.update(a.id, { status: 'merged' });

    await unblockDependents(a.id, {
      configStore: ctx.configStore,
      taskStore: ctx.taskStore,
      queue: ctx.queue,
    });

    const jobs = await ctx.queue.list({ taskId: b.id });
    expect(jobs).toHaveLength(0);
  });

  test('circular deps prevented at creation — updateDependencies throws', async () => {
    const a = await ctx.taskStore.create({ title: 'A' });
    const b = await ctx.taskStore.create({ title: 'B' });

    await ctx.taskStore.addDependency(b.id, a.id);

    // Trying to make A depend on B should fail (cycle: A → B → A)
    expect(ctx.taskStore.addDependency(a.id, b.id)).rejects.toThrow(
      /circular dependency/,
    );
  });

  test('unblockDependents with nonexistent taskId — no-op', async () => {
    await unblockDependents('ghost-task-id', {
      configStore: ctx.configStore,
      taskStore: ctx.taskStore,
      queue: ctx.queue,
    });

    const jobs = await ctx.queue.list();
    expect(jobs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Config interaction
// ---------------------------------------------------------------------------

describe('config interaction with chain', () => {
  test('config change between calls — second call respects new config', async () => {
    const task1 = await ctx.taskStore.create({ title: 'T1' });
    const task2 = await ctx.taskStore.create({ title: 'T2' });

    const deps = {
      configStore: ctx.configStore,
      taskStore: ctx.taskStore,
      queue: ctx.queue,
    };

    // First call with autoRun enabled — should enqueue
    await resumeChain(task1.id, 'planned', deps);
    const jobs1 = await ctx.queue.list({ taskId: task1.id });
    expect(jobs1).toHaveLength(1);

    // Disable code autoRun
    await ctx.configStore.patch({
      interactions: {
        code: { tool: 'claude', model: 'test', autoRun: false },
      },
    });

    // Second call with autoRun disabled — should NOT enqueue
    await resumeChain(task2.id, 'planned', deps);
    const jobs2 = await ctx.queue.list({ taskId: task2.id });
    expect(jobs2).toHaveLength(0);
  });

  test('missing interaction config — defaults to autoRun true', async () => {
    // Patch config to have empty interactions (clear all)
    await ctx.configStore.patch({
      interactions: {},
    });

    const task = await ctx.taskStore.create({ title: 'T' });

    await resumeChain(task.id, 'planned', {
      configStore: ctx.configStore,
      taskStore: ctx.taskStore,
      queue: ctx.queue,
    });

    // isAutoRun defaults to true when config entry is missing
    const jobs = await ctx.queue.list({ taskId: task.id });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.type).toBe('code');
  });

  test('config change affects unblockDependents — disabled evaluate skips', async () => {
    const a = await ctx.taskStore.create({ title: 'A' });
    const b = await ctx.taskStore.create({ title: 'B' });

    await ctx.taskStore.addDependency(b.id, a.id);
    await ctx.taskStore.update(a.id, { status: 'merged' });

    // Disable evaluate globally
    await ctx.configStore.patch({
      interactions: {
        evaluate: { tool: 'claude', model: 'test', autoRun: false },
      },
    });

    await unblockDependents(a.id, {
      configStore: ctx.configStore,
      taskStore: ctx.taskStore,
      queue: ctx.queue,
    });

    const jobs = await ctx.queue.list({ taskId: b.id });
    expect(jobs).toHaveLength(0);
  });
});
