import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseConnection } from '../../../src/db/connection';
import {
  failInFlightForShutdown,
  runStartupRecovery,
} from '../../../src/domain/recovery';
import { JobQueue } from '../../../src/queue/queue';
import { InteractionStore } from '../../../src/store/interactions';
import { TaskStore } from '../../../src/store/tasks';
import { createTestDB } from '../../helpers/db';

let conn: DatabaseConnection;
let taskStore: TaskStore;
let interactions: InteractionStore;
let queue: JobQueue;
let tmpDir: string;

beforeEach(async () => {
  conn = createTestDB();
  tmpDir = await mkdtemp(join(tmpdir(), 'orca-test-'));
  taskStore = new TaskStore(conn.db);
  interactions = new InteractionStore(conn.db, tmpDir);
  queue = new JobQueue(conn.db);
});

afterEach(async () => {
  conn.close();
  await rm(tmpDir, { recursive: true, force: true });
});

describe('failInFlightForShutdown', () => {
  test('no running interactions or tasks returns all zeros', async () => {
    const result = await failInFlightForShutdown(taskStore, interactions);
    expect(result).toEqual({
      interactionsFailed: 0,
      tasksStopped: 0,
      tasksFailed: 0,
    });
  });

  test('running code interaction + running task without sessionId → interaction failed, task failed', async () => {
    const task = await taskStore.create({ title: 'test task' });
    await taskStore.updateStatus(task.id, 'running');
    await interactions.begin({ taskId: task.id, type: 'code', tool: 'claude' });

    const result = await failInFlightForShutdown(taskStore, interactions);

    expect(result.interactionsFailed).toBe(1);
    expect(result.tasksFailed).toBe(1);
    expect(result.tasksStopped).toBe(0);

    const updated = await taskStore.get(task.id);
    expect(updated!.status).toBe('failed');
  });

  test('running code interaction + running task with sessionId → task stopped', async () => {
    const task = await taskStore.create({ title: 'test task' });
    await taskStore.updateStatus(task.id, 'running');
    await taskStore.setSessionID(task.id, 'sess-123');
    await interactions.begin({ taskId: task.id, type: 'code', tool: 'claude' });

    const result = await failInFlightForShutdown(taskStore, interactions);

    expect(result.interactionsFailed).toBe(1);
    expect(result.tasksStopped).toBe(1);
    expect(result.tasksFailed).toBe(0);

    const updated = await taskStore.get(task.id);
    expect(updated!.status).toBe('stopped');
  });

  test('running interaction with non-code type → interaction failed, task NOT changed by interaction loop', async () => {
    // Task is pending (not running) so only the interaction is affected
    const task = await taskStore.create({ title: 'test task' });
    await interactions.begin({
      taskId: task.id,
      type: 'evaluate',
      tool: 'claude',
    });

    const result = await failInFlightForShutdown(taskStore, interactions);

    expect(result.interactionsFailed).toBe(1);
    // Non-code interaction does not trigger task status change
    expect(result.tasksFailed).toBe(0);
    expect(result.tasksStopped).toBe(0);

    const updated = await taskStore.get(task.id);
    expect(updated!.status).toBe('pending');
  });

  test('multiple running interactions → all counted', async () => {
    const task1 = await taskStore.create({ title: 'task 1' });
    await taskStore.updateStatus(task1.id, 'running');
    const task2 = await taskStore.create({ title: 'task 2' });
    await taskStore.updateStatus(task2.id, 'running');

    await interactions.begin({
      taskId: task1.id,
      type: 'code',
      tool: 'claude',
    });
    await interactions.begin({
      taskId: task2.id,
      type: 'code',
      tool: 'claude',
    });

    const result = await failInFlightForShutdown(taskStore, interactions);

    expect(result.interactionsFailed).toBe(2);
    // Both tasks failed via the interaction loop (no sessionId), none left for second pass
    expect(result.tasksFailed).toBe(2);
    expect(result.tasksStopped).toBe(0);
  });

  test('calls log callback with events', async () => {
    const task = await taskStore.create({ title: 'logged task' });
    await taskStore.updateStatus(task.id, 'running');
    await interactions.begin({ taskId: task.id, type: 'code', tool: 'claude' });

    const events: Array<{ event: string; data?: Record<string, unknown> }> = [];
    const log = (event: string, data?: Record<string, unknown>) => {
      events.push({ event, data });
    };

    await failInFlightForShutdown(taskStore, interactions, log);

    const eventNames = events.map((e) => e.event);
    expect(eventNames).toContain('shutdown.recovery.interaction.failed');
    expect(eventNames).toContain('shutdown.recovery.complete');
  });
});

describe('runStartupRecovery', () => {
  test('no running interactions returns all zeros', async () => {
    const result = await runStartupRecovery(taskStore, interactions);
    expect(result).toEqual({
      interactionsFailed: 0,
      tasksStopped: 0,
      tasksFailed: 0,
    });
  });

  test('running interaction → marked failed with unclean shutdown error', async () => {
    const task = await taskStore.create({ title: 'test task' });
    const { id: interactionId } = await interactions.begin({
      taskId: task.id,
      type: 'code',
      tool: 'claude',
    });

    const result = await runStartupRecovery(taskStore, interactions);

    expect(result.interactionsFailed).toBe(1);

    const updated = await interactions.get(interactionId);
    expect(updated!.status).toBe('failed');
    expect(updated!.error).toBe('unclean shutdown');
  });

  test('running task without sessionId → failed (no queue)', async () => {
    const task = await taskStore.create({ title: 'test task' });
    await taskStore.updateStatus(task.id, 'running');

    const result = await runStartupRecovery(taskStore, interactions);

    expect(result.tasksFailed).toBe(1);
    expect(result.tasksStopped).toBe(0);

    const updated = await taskStore.get(task.id);
    expect(updated!.status).toBe('failed');
  });

  test('running task with sessionId → stopped (no queue)', async () => {
    const task = await taskStore.create({ title: 'test task' });
    await taskStore.updateStatus(task.id, 'running');
    await taskStore.setSessionID(task.id, 'sess-abc');

    const result = await runStartupRecovery(taskStore, interactions);

    expect(result.tasksStopped).toBe(1);
    expect(result.tasksFailed).toBe(0);

    const updated = await taskStore.get(task.id);
    expect(updated!.status).toBe('stopped');
  });

  test('with queue → calls requeueRunning instead of resetting tasks', async () => {
    const task = await taskStore.create({ title: 'test task' });
    await taskStore.updateStatus(task.id, 'running');

    // When queue is provided, tasks are NOT reset directly — requeueRunning handles it
    const result = await runStartupRecovery(
      taskStore,
      interactions,
      undefined,
      queue,
    );

    // No direct task resets when queue is provided
    expect(result.tasksFailed).toBe(0);
    expect(result.tasksStopped).toBe(0);

    // Task status remains running (queue handles requeue, not direct status update)
    const updated = await taskStore.get(task.id);
    expect(updated!.status).toBe('running');
  });

  test('preserves existing error message on interaction', async () => {
    const task = await taskStore.create({ title: 'test task' });
    const { id: interactionId } = await interactions.begin({
      taskId: task.id,
      type: 'code',
      tool: 'claude',
    });

    // Simulate an error already set on the interaction row
    // We need to set error directly — finish would change status, so we use db directly
    const { taskInteractions } = await import('../../../src/db/schema');
    const { eq } = await import('drizzle-orm');
    await conn.db
      .update(taskInteractions)
      .set({ error: 'process killed' })
      .where(eq(taskInteractions.id, interactionId));

    const result = await runStartupRecovery(taskStore, interactions);

    expect(result.interactionsFailed).toBe(1);

    const updated = await interactions.get(interactionId);
    expect(updated!.status).toBe('failed');
    expect(updated!.error).toBe('process killed');
  });
});
