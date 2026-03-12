import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OrcaDrizzleDB } from '../../../src/db/connection';
import {
  failInFlightForShutdown,
  runStartupRecovery,
} from '../../../src/domain/recovery';
import { JobQueue } from '../../../src/queue/queue';
import { InteractionStore } from '../../../src/store/interactions';
import {
  createTask,
  getTask,
  updateTask,
} from '../../../src/store/tasks';
import { createTestDB } from '../../helpers/db';

let db: OrcaDrizzleDB;
let closeFn: () => void;
let interactions: InteractionStore;
let queue: JobQueue;
let tmpDir: string;

beforeEach(async () => {
  const conn = createTestDB();
  db = conn.db;
  closeFn = conn.close;
  tmpDir = await mkdtemp(join(tmpdir(), 'orca-test-'));
  interactions = new InteractionStore(db, tmpDir);
  queue = new JobQueue(db);
});

afterEach(async () => {
  closeFn();
  await rm(tmpDir, { recursive: true, force: true });
});

describe('failInFlightForShutdown', () => {
  test('running code interaction + running task without sessionId → interaction failed, task failed', async () => {
    await createTask(db, undefined, { id: 'task-1', title: 'test task' });
    await updateTask(db, undefined, 'task-1', { status: 'running' });
    await interactions.begin({ taskId: 'task-1', type: 'code', tool: 'claude' });

    const result = await failInFlightForShutdown(db, interactions);

    expect(result.interactionsFailed).toBe(1);
    expect(result.tasksFailed).toBe(1);
    expect(result.tasksStopped).toBe(0);

    const updated = await getTask(db, 'task-1');
    expect(updated.status).toBe('failed');
  });

  test('running code interaction + running task with sessionId → task stopped', async () => {
    await createTask(db, undefined, { id: 'task-2', title: 'test task' });
    await updateTask(db, undefined, 'task-2', { status: 'running' });
    const prevIx = await interactions.begin({ taskId: 'task-2', type: 'code', tool: 'claude' });
    await interactions.finish(prevIx.id, { status: 'completed', sessionId: 'sess-123' });
    await interactions.begin({ taskId: 'task-2', type: 'code', tool: 'claude' });

    const result = await failInFlightForShutdown(db, interactions);

    expect(result.interactionsFailed).toBe(1);
    expect(result.tasksStopped).toBe(1);
    expect(result.tasksFailed).toBe(0);

    const updated = await getTask(db, 'task-2');
    expect(updated.status).toBe('stopped');
  });

  test('running interaction with non-code type → interaction failed, task NOT changed by interaction loop', async () => {
    // Task is pending (not running) so only the interaction is affected
    await createTask(db, undefined, { id: 'task-3', title: 'test task' });
    await interactions.begin({
      taskId: 'task-3',
      type: 'evaluate',
      tool: 'claude',
    });

    const result = await failInFlightForShutdown(db, interactions);

    expect(result.interactionsFailed).toBe(1);
    // Non-code interaction does not trigger task status change
    expect(result.tasksFailed).toBe(0);
    expect(result.tasksStopped).toBe(0);

    const updated = await getTask(db, 'task-3');
    expect(updated.status).toBe('pending');
  });

  test('multiple running interactions → all counted', async () => {
    await createTask(db, undefined, { id: 'task-4', title: 'task 1' });
    await updateTask(db, undefined, 'task-4', { status: 'running' });
    await createTask(db, undefined, { id: 'task-5', title: 'task 2' });
    await updateTask(db, undefined, 'task-5', { status: 'running' });

    await interactions.begin({ taskId: 'task-4', type: 'code', tool: 'claude' });
    await interactions.begin({ taskId: 'task-5', type: 'code', tool: 'claude' });

    const result = await failInFlightForShutdown(db, interactions);

    expect(result.interactionsFailed).toBe(2);
    // Both tasks failed via the interaction loop (no sessionId), none left for second pass
    expect(result.tasksFailed).toBe(2);
    expect(result.tasksStopped).toBe(0);
  });

  test('calls log callback with events', async () => {
    await createTask(db, undefined, { id: 'task-6', title: 'logged task' });
    await updateTask(db, undefined, 'task-6', { status: 'running' });
    await interactions.begin({ taskId: 'task-6', type: 'code', tool: 'claude' });

    const events: Array<{ event: string; data?: Record<string, unknown> }> = [];
    const log = (event: string, data?: Record<string, unknown>) => {
      events.push({ event, data });
    };

    await failInFlightForShutdown(db, interactions, log);

    const eventNames = events.map((e) => e.event);
    expect(eventNames).toContain('shutdown.recovery.interaction.failed');
    expect(eventNames).toContain('shutdown.recovery.complete');
  });
});

describe('runStartupRecovery', () => {
  test('no running interactions returns all zeros', async () => {
    const result = await runStartupRecovery(db, interactions);
    expect(result).toEqual({
      interactionsFailed: 0,
      tasksStopped: 0,
      tasksFailed: 0,
    });
  });

  test('running interaction → marked failed with unclean shutdown error', async () => {
    await createTask(db, undefined, { id: 'task-r1', title: 'test task' });
    const { id: interactionId } = await interactions.begin({
      taskId: 'task-r1',
      type: 'code',
      tool: 'claude',
    });

    const result = await runStartupRecovery(db, interactions);

    expect(result.interactionsFailed).toBe(1);

    const updated = await interactions.get(interactionId);
    expect(updated!.status).toBe('failed');
    expect(updated!.error).toBe('unclean shutdown');
  });

  test('running task without sessionId → failed (no queue)', async () => {
    await createTask(db, undefined, { id: 'task-r2', title: 'test task' });
    await updateTask(db, undefined, 'task-r2', { status: 'running' });

    const result = await runStartupRecovery(db, interactions);

    expect(result.tasksFailed).toBe(1);
    expect(result.tasksStopped).toBe(0);

    const updated = await getTask(db, 'task-r2');
    expect(updated.status).toBe('failed');
  });

  test('running task with sessionId → stopped (no queue)', async () => {
    await createTask(db, undefined, { id: 'task-r3', title: 'test task' });
    await updateTask(db, undefined, 'task-r3', { status: 'running' });
    const prevIx = await interactions.begin({ taskId: 'task-r3', type: 'code', tool: 'claude' });
    await interactions.finish(prevIx.id, { status: 'completed', sessionId: 'sess-abc' });

    const result = await runStartupRecovery(db, interactions);

    expect(result.tasksStopped).toBe(1);
    expect(result.tasksFailed).toBe(0);

    const updated = await getTask(db, 'task-r3');
    expect(updated.status).toBe('stopped');
  });

  test('with queue → calls requeueRunning instead of resetting tasks', async () => {
    await createTask(db, undefined, { id: 'task-r4', title: 'test task' });
    await updateTask(db, undefined, 'task-r4', { status: 'running' });

    // When queue is provided, tasks are NOT reset directly — requeueRunning handles it
    const result = await runStartupRecovery(db, interactions, undefined, queue);

    // No direct task resets when queue is provided
    expect(result.tasksFailed).toBe(0);
    expect(result.tasksStopped).toBe(0);

    // Task status remains running (queue handles requeue, not direct status update)
    const updated = await getTask(db, 'task-r4');
    expect(updated.status).toBe('running');
  });

  test('preserves existing error message on interaction', async () => {
    await createTask(db, undefined, { id: 'task-r5', title: 'test task' });
    const { id: interactionId } = await interactions.begin({
      taskId: 'task-r5',
      type: 'code',
      tool: 'claude',
    });

    // Simulate an error already set on the interaction row
    // We need to set error directly — finish would change status, so we use db directly
    const { taskInteractions } = await import('../../../src/db/schema');
    const { eq } = await import('drizzle-orm');
    await db
      .update(taskInteractions)
      .set({ error: 'process killed' })
      .where(eq(taskInteractions.id, interactionId));

    const result = await runStartupRecovery(db, interactions);

    expect(result.interactionsFailed).toBe(1);

    const updated = await interactions.get(interactionId);
    expect(updated!.status).toBe('failed');
    expect(updated!.error).toBe('process killed');
  });
});
