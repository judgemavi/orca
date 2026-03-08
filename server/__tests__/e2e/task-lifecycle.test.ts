import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { buildRoutes } from '../../src/api/routes';
import type { DatabaseConnection } from '../../src/db/connection';
import { EmbeddingRegistry } from '../../src/embedding/registry';
import { JobQueue } from '../../src/queue/queue';
import { ConfigStore } from '../../src/store/config';
import { InteractionStore } from '../../src/store/interactions';
import { MemoryStore } from '../../src/store/memory';
import { TaskStore } from '../../src/store/tasks';
import { createTestDB } from '../helpers/db';

let conn: DatabaseConnection;
let app: ReturnType<typeof buildRoutes>;

function stubSink() {
  return { broadcast: () => {}, close: () => {} } as any;
}

function stubExecutor() {
  return {} as any;
}

function stubRegistry() {
  return {
    available: () => ['claude'],
    registered: () => ['claude'],
    get: () => null,
    register: () => {},
  } as any;
}

beforeEach(async () => {
  conn = createTestDB();
  const sink = stubSink();
  const taskStore = new TaskStore(conn.db, sink);
  const interactionStore = new InteractionStore(
    conn.db,
    '/tmp/test-interactions',
    sink,
  );
  const memoryStore = new MemoryStore(conn.db, sink);
  const configStore = new ConfigStore(conn.db);
  const queue = new JobQueue(conn.db, sink);
  const embeddingRegistry = new EmbeddingRegistry();

  app = buildRoutes({
    db: conn.db,
    repoDir: '/tmp/test-repo',
    taskStore,
    configStore,
    interactionStore,
    memoryStore,
    registry: stubRegistry(),
    embeddingRegistry,
    executor: stubExecutor(),
    eventSink: sink,
    queue,
  });

  // Enable auto-run for chaining tests
  await configStore.patch({
    interactions: {
      evaluate: { tool: 'claude', model: 'test', autoRun: true },
      code: { tool: 'claude', model: 'test', autoRun: true },
      merge: { tool: 'claude', model: 'test', autoRun: true },
    },
  });
});

afterEach(() => {
  conn.close();
});

async function api(path: string, init?: RequestInit) {
  return app.request(`/api/v1${path}`, init);
}

async function post(path: string, body: unknown) {
  return api(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function patch(path: string, body: unknown) {
  return api(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function json(res: Response) {
  return res.json();
}

describe('health check', () => {
  test('GET /health returns ok', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.status).toBe('ok');
  });
});

describe('task lifecycle: create → deps → status transitions', () => {
  test('create task without deps enqueues evaluate', async () => {
    const res = await post('/tasks', { title: 'Standalone task' });
    expect(res.status).toBe(201);
    const task = await json(res);
    expect(task.status).toBe('pending');

    // Verify evaluate job was queued
    const queueRes = await api(`/queue?taskId=${task.id}`);
    const jobs = await json(queueRes);
    expect(jobs.length).toBeGreaterThanOrEqual(1);
    expect(jobs.some((j: any) => j.type === 'evaluate')).toBe(true);
  });

  test('create task with deps does NOT enqueue evaluate', async () => {
    const depRes = await post('/tasks', { title: 'Dependency' });
    const dep = await json(depRes);

    const res = await post('/tasks', {
      title: 'Blocked task',
      dependsOn: [dep.id],
    });
    expect(res.status).toBe(201);
    const task = await json(res);
    expect(task.dependsOn).toEqual([dep.id]);

    const queueRes = await api(`/queue?taskId=${task.id}`);
    const jobs = await json(queueRes);
    expect(jobs).toHaveLength(0);
  });

  test('full dependency chain: A → B, merge A unblocks B', async () => {
    // Create A (independent)
    const aRes = await post('/tasks', { title: 'Task A' });
    const a = await json(aRes);

    // Create B (depends on A)
    const bRes = await post('/tasks', {
      title: 'Task B',
      dependsOn: [a.id],
    });
    const b = await json(bRes);

    // B should have no jobs
    const bJobsRes = await api(`/queue?taskId=${b.id}`);
    expect(await json(bJobsRes)).toHaveLength(0);

    // Verify A has evaluate job
    const aJobsRes = await api(`/queue?taskId=${a.id}`);
    const aJobs = await json(aJobsRes);
    expect(aJobs.some((j: any) => j.type === 'evaluate')).toBe(true);
  });

  test('patch deps on existing task', async () => {
    const aRes = await post('/tasks', { title: 'A' });
    const a = await json(aRes);
    const bRes = await post('/tasks', { title: 'B' });
    const b = await json(bRes);

    // Add dep via patch
    const patchRes = await patch(`/tasks/${b.id}`, { dependsOn: [a.id] });
    expect(patchRes.status).toBe(200);
    const patched = await json(patchRes);
    expect(patched.dependsOn).toEqual([a.id]);

    // Remove dep via patch
    const clearRes = await patch(`/tasks/${b.id}`, { dependsOn: [] });
    const cleared = await json(clearRes);
    expect(cleared.dependsOn).toEqual([]);
  });
});

describe('task status transitions via API', () => {
  test('can stop a task', async () => {
    const res = await post('/tasks', { title: 'T' });
    const task = await json(res);

    const stopRes = await patch(`/tasks/${task.id}`, { status: 'stopped' });
    expect(stopRes.status).toBe(200);
    expect((await json(stopRes)).status).toBe('stopped');
  });

  test('cannot set pending task to running', async () => {
    const res = await post('/tasks', { title: 'T' });
    const task = await json(res);

    const badRes = await patch(`/tasks/${task.id}`, { status: 'running' });
    expect(badRes.status).toBe(400);
  });

  test('failed → pending is allowed', async () => {
    const res = await post('/tasks', { title: 'T' });
    const task = await json(res);

    await patch(`/tasks/${task.id}`, { status: 'failed' });
    const retryRes = await patch(`/tasks/${task.id}`, { status: 'pending' });
    expect(retryRes.status).toBe(200);
    expect((await json(retryRes)).status).toBe('pending');
  });

  test('pending → pending is rejected', async () => {
    const res = await post('/tasks', { title: 'T' });
    const task = await json(res);

    const badRes = await patch(`/tasks/${task.id}`, { status: 'pending' });
    expect(badRes.status).toBe(400);
  });
});

describe('queue management via API', () => {
  test('drain cancels all queued jobs', async () => {
    await post('/tasks', { title: 'T1' });
    await post('/tasks', { title: 'T2' });

    const countsRes = await api('/queue/counts');
    const counts = await json(countsRes);
    expect(counts['queued']).toBeGreaterThanOrEqual(2);

    const drainRes = await api('/queue', { method: 'DELETE' });
    const drained = await json(drainRes);
    expect(drained.cancelled).toBeGreaterThanOrEqual(2);

    const afterRes = await api('/queue/counts');
    const after = await json(afterRes);
    expect(after['queued'] ?? 0).toBe(0);
  });
});

describe('config via API', () => {
  test('GET config returns valid config', async () => {
    const res = await api('/config');
    expect(res.status).toBe(200);
    const config = await json(res);
    expect(config.workers).toBeTruthy();
    expect(config.interactions).toBeTruthy();
  });

  test('PUT config patches and returns updated', async () => {
    const res = await api('/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workers: { maxParallel: 8 } }),
    });
    expect(res.status).toBe(200);
    const config = await json(res);
    expect(config.workers.maxParallel).toBe(8);
  });
});

describe('task CRUD via API', () => {
  test('create, list, get, delete flow', async () => {
    // Create
    const createRes = await post('/tasks', { title: 'E2E Task' });
    expect(createRes.status).toBe(201);
    const task = await json(createRes);

    // List
    const listRes = await api('/tasks');
    const tasks = await json(listRes);
    expect(tasks.some((t: any) => t.id === task.id)).toBe(true);

    // Get
    const getRes = await api(`/tasks/${task.id}`);
    expect((await json(getRes)).title).toBe('E2E Task');

    // Delete
    const delRes = await api(`/tasks/${task.id}`, { method: 'DELETE' });
    expect(delRes.status).toBe(200);

    // Verify gone
    const goneRes = await api(`/tasks/${task.id}`);
    expect(goneRes.status).toBe(404);
  });
});
