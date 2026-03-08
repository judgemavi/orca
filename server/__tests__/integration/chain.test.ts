import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { resumeChain, unblockDependents } from '../../src/queue/chain';
import type { TestContext } from '../helpers/db';
import { createTestContext } from '../helpers/db';

let ctx: TestContext;

beforeEach(async () => {
  ctx = createTestContext();
  // Enable auto-run for all interaction types
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

describe('resumeChain', () => {
  test('planned → enqueues code job', async () => {
    const task = await ctx.taskStore.create({ title: 'T' });
    await resumeChain(task.id, 'planned', {
      configStore: ctx.configStore,
      taskStore: ctx.taskStore,
      queue: ctx.queue,
    });

    const jobs = await ctx.queue.list({ taskId: task.id });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.type).toBe('code');
  });

  test('approved → enqueues merge job', async () => {
    const task = await ctx.taskStore.create({ title: 'T' });
    await resumeChain(task.id, 'approved', {
      configStore: ctx.configStore,
      taskStore: ctx.taskStore,
      queue: ctx.queue,
    });

    const jobs = await ctx.queue.list({ taskId: task.id });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.type).toBe('merge');
  });

  test('does not enqueue for non-chained statuses', async () => {
    const task = await ctx.taskStore.create({ title: 'T' });
    await resumeChain(task.id, 'pending', {
      configStore: ctx.configStore,
      taskStore: ctx.taskStore,
      queue: ctx.queue,
    });

    const jobs = await ctx.queue.list({ taskId: task.id });
    expect(jobs).toHaveLength(0);
  });

  test('skips chain when autoRun disabled', async () => {
    await ctx.configStore.patch({
      interactions: {
        code: { tool: 'claude', model: 'test', autoRun: false },
      },
    });

    const task = await ctx.taskStore.create({ title: 'T' });
    await resumeChain(task.id, 'planned', {
      configStore: ctx.configStore,
      taskStore: ctx.taskStore,
      queue: ctx.queue,
    });

    const jobs = await ctx.queue.list({ taskId: task.id });
    expect(jobs).toHaveLength(0);
  });

  test('skips chain when deps not met', async () => {
    const dep = await ctx.taskStore.create({ title: 'Dep' });
    const task = await ctx.taskStore.create({ title: 'T' });
    await ctx.taskStore.addDependency(task.id, dep.id);

    await resumeChain(task.id, 'planned', {
      configStore: ctx.configStore,
      taskStore: ctx.taskStore,
      queue: ctx.queue,
    });

    const jobs = await ctx.queue.list({ taskId: task.id });
    expect(jobs).toHaveLength(0);
  });

  test('per-task autoRunOverrides disable chain', async () => {
    const task = await ctx.taskStore.create({
      title: 'T',
      autoRunOverrides: { code: false },
    });

    await resumeChain(task.id, 'planned', {
      configStore: ctx.configStore,
      taskStore: ctx.taskStore,
      queue: ctx.queue,
    });

    const jobs = await ctx.queue.list({ taskId: task.id });
    expect(jobs).toHaveLength(0);
  });
});

describe('unblockDependents', () => {
  test('enqueues evaluate for pending dependents when dep merges', async () => {
    const a = await ctx.taskStore.create({ title: 'A' });
    const b = await ctx.taskStore.create({ title: 'B' });
    await ctx.taskStore.addDependency(b.id, a.id);
    await ctx.taskStore.update(a.id, { status: 'merged' });

    await unblockDependents(a.id, {
      configStore: ctx.configStore,
      taskStore: ctx.taskStore,
      queue: ctx.queue,
    });

    const jobs = await ctx.queue.list({ taskId: b.id });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.type).toBe('evaluate');
  });

  test('enqueues code for planned dependents when dep merges', async () => {
    const a = await ctx.taskStore.create({ title: 'A' });
    const b = await ctx.taskStore.create({ title: 'B' });
    await ctx.taskStore.addDependency(b.id, a.id);
    await ctx.taskStore.update(b.id, { status: 'planned' });
    await ctx.taskStore.update(a.id, { status: 'merged' });

    await unblockDependents(a.id, {
      configStore: ctx.configStore,
      taskStore: ctx.taskStore,
      queue: ctx.queue,
    });

    const jobs = await ctx.queue.list({ taskId: b.id });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.type).toBe('code');
  });

  test('does not unblock when other deps still pending', async () => {
    const a = await ctx.taskStore.create({ title: 'A' });
    const b = await ctx.taskStore.create({ title: 'B' });
    const c = await ctx.taskStore.create({ title: 'C' });
    await ctx.taskStore.updateDependencies(c.id, [a.id, b.id]);
    await ctx.taskStore.update(a.id, { status: 'merged' });

    await unblockDependents(a.id, {
      configStore: ctx.configStore,
      taskStore: ctx.taskStore,
      queue: ctx.queue,
    });

    const jobs = await ctx.queue.list({ taskId: c.id });
    expect(jobs).toHaveLength(0);
  });

  test('no-op when no dependents', async () => {
    const a = await ctx.taskStore.create({ title: 'A' });
    await ctx.taskStore.update(a.id, { status: 'merged' });

    await unblockDependents(a.id, {
      configStore: ctx.configStore,
      taskStore: ctx.taskStore,
      queue: ctx.queue,
    });

    const allJobs = await ctx.queue.list();
    expect(allJobs).toHaveLength(0);
  });
});
