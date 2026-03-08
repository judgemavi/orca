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

describe('JobQueue.enqueue', () => {
  test('creates a queued job', async () => {
    const job = await ctx.queue.enqueue({ type: 'evaluate', taskId: 'task-1' });
    expect(job.id).toBeTruthy();
    expect(job.type).toBe('evaluate');
    expect(job.taskId).toBe('task-1');
    expect(job.status).toBe('queued');
  });

  test('assigns default priority from type', async () => {
    const job = await ctx.queue.enqueue({ type: 'code' });
    expect(job.priority).toBe(0); // code = 0 (highest)
  });

  test('accepts custom priority', async () => {
    const job = await ctx.queue.enqueue({
      type: 'evaluate',
      priority: 99,
    });
    expect(job.priority).toBe(99);
  });

  test('stores payload', async () => {
    const job = await ctx.queue.enqueue({
      type: 'code',
      payload: { tool: 'claude', model: 'opus' },
    });
    expect(job.payload).toEqual({ tool: 'claude', model: 'opus' });
  });
});

describe('JobQueue.claim', () => {
  test('claims queued jobs by priority then createdAt', async () => {
    await ctx.queue.enqueue({ type: 'evaluate', taskId: 'low-pri' }); // pri 3
    await ctx.queue.enqueue({ type: 'code', taskId: 'high-pri' }); // pri 0

    const claimed = await ctx.queue.claim(2);
    expect(claimed).toHaveLength(2);
    expect(claimed[0]!.taskId).toBe('high-pri');
    expect(claimed[1]!.taskId).toBe('low-pri');
    expect(claimed[0]!.status).toBe('running');
  });

  test('respects maxParallel limit', async () => {
    await ctx.queue.enqueue({ type: 'code', taskId: 't1' });
    await ctx.queue.enqueue({ type: 'code', taskId: 't2' });
    await ctx.queue.enqueue({ type: 'code', taskId: 't3' });

    const first = await ctx.queue.claim(1);
    expect(first).toHaveLength(1);

    // Already 1 running, maxParallel=2 → claim 1 more
    const second = await ctx.queue.claim(2);
    expect(second).toHaveLength(1);
  });

  test('returns empty when nothing queued', async () => {
    expect(await ctx.queue.claim(5)).toEqual([]);
  });

  test('returns empty when at max parallel', async () => {
    await ctx.queue.enqueue({ type: 'code' });
    await ctx.queue.claim(1); // now 1 running

    await ctx.queue.enqueue({ type: 'code' });
    const claimed = await ctx.queue.claim(1); // max=1, already 1 running
    expect(claimed).toEqual([]);
  });
});

describe('JobQueue.complete', () => {
  test('marks job as completed', async () => {
    const job = await ctx.queue.enqueue({ type: 'code' });
    const [claimed] = await ctx.queue.claim(1);
    await ctx.queue.complete(claimed!.id, { output: 'done' });

    const fetched = await ctx.queue.get(job.id);
    expect(fetched!.status).toBe('completed');
    expect(fetched!.result).toEqual({ output: 'done' });
    expect(fetched!.completedAt).toBeTruthy();
  });
});

describe('JobQueue.fail', () => {
  test('marks job as failed with error', async () => {
    const job = await ctx.queue.enqueue({ type: 'code' });
    await ctx.queue.claim(1);
    await ctx.queue.fail(job.id, 'something broke');

    const fetched = await ctx.queue.get(job.id);
    expect(fetched!.status).toBe('failed');
    expect(fetched!.error).toBe('something broke');
  });
});

describe('JobQueue.cancel', () => {
  test('cancels a queued job', async () => {
    const job = await ctx.queue.enqueue({ type: 'code' });
    const cancelled = await ctx.queue.cancel(job.id);
    expect(cancelled).toBe(true);

    const fetched = await ctx.queue.get(job.id);
    expect(fetched!.status).toBe('cancelled');
  });

  test('cannot cancel a running job', async () => {
    await ctx.queue.enqueue({ type: 'code' });
    const [claimed] = await ctx.queue.claim(1);
    const cancelled = await ctx.queue.cancel(claimed!.id);
    expect(cancelled).toBe(false);
  });
});

describe('JobQueue.cancelForTask', () => {
  test('cancels all queued jobs for a task', async () => {
    await ctx.queue.enqueue({ type: 'evaluate', taskId: 'task-1' });
    await ctx.queue.enqueue({ type: 'code', taskId: 'task-1' });
    await ctx.queue.enqueue({ type: 'code', taskId: 'task-2' });

    const count = await ctx.queue.cancelForTask('task-1');
    expect(count).toBe(2);

    const remaining = await ctx.queue.list({ status: 'queued' });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.taskId).toBe('task-2');
  });
});

describe('JobQueue.list', () => {
  test('lists jobs with filters', async () => {
    await ctx.queue.enqueue({ type: 'evaluate', taskId: 't1' });
    await ctx.queue.enqueue({ type: 'code', taskId: 't2' });

    const all = await ctx.queue.list();
    expect(all).toHaveLength(2);

    const byTask = await ctx.queue.list({ taskId: 't1' });
    expect(byTask).toHaveLength(1);
  });
});

describe('JobQueue.counts', () => {
  test('returns status counts', async () => {
    await ctx.queue.enqueue({ type: 'code' });
    await ctx.queue.enqueue({ type: 'code' });
    const [claimed] = await ctx.queue.claim(1);
    await ctx.queue.complete(claimed!.id);

    const counts = await ctx.queue.counts();
    expect(counts['queued']).toBe(1);
    expect(counts['completed']).toBe(1);
  });
});

describe('JobQueue.drain', () => {
  test('cancels all queued jobs', async () => {
    await ctx.queue.enqueue({ type: 'code' });
    await ctx.queue.enqueue({ type: 'evaluate' });

    const drained = await ctx.queue.drain();
    expect(drained).toBe(2);

    const queued = await ctx.queue.list({ status: 'queued' });
    expect(queued).toEqual([]);
  });

  test('does not cancel running jobs', async () => {
    await ctx.queue.enqueue({ type: 'code' });
    await ctx.queue.claim(1);
    await ctx.queue.enqueue({ type: 'code' });

    const drained = await ctx.queue.drain();
    expect(drained).toBe(1);

    const running = await ctx.queue.list({ status: 'running' });
    expect(running).toHaveLength(1);
  });
});

describe('JobQueue.requeueRunning', () => {
  test('moves running jobs back to queued', async () => {
    await ctx.queue.enqueue({ type: 'code' });
    await ctx.queue.claim(1);

    const requeued = await ctx.queue.requeueRunning();
    expect(requeued).toBe(1);

    const queued = await ctx.queue.list({ status: 'queued' });
    expect(queued).toHaveLength(1);
  });
});
