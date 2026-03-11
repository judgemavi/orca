import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { EmbeddingRegistry } from '../../src/embedding/registry';
import { buildRoutes } from '../../src/api/routes';
import { WorkflowStore } from '../../src/workflow/store';
import { type E2EEnv, createE2EEnv } from '../helpers/e2e-env';

let env: E2EEnv;
let app: ReturnType<typeof buildRoutes>;

const api = (path: string, init?: RequestInit) =>
  app.request(`/api/v1${path}`, init);

const json = async (path: string, init?: RequestInit) => {
  const res = await api(path, init);
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};

const post = (path: string, data: unknown) =>
  json(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });

const patchReq = (path: string, data: unknown) =>
  json(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });

const put = (path: string, data: unknown) =>
  json(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });

beforeEach(async () => {
  env = await createE2EEnv();
  env.startProcessor();
  const embeddingRegistry = new EmbeddingRegistry(false);
  app = buildRoutes({
    db: env.conn.db,
    repoDir: env.repoDir,
    interactionStore: env.interactionStore,
    memoryStore: env.memoryStore,
    registry: env.registry,
    embeddingRegistry,
    executor: env.executor,
    eventSink: env.sink,
    queue: env.queue,
    workflowStore: new WorkflowStore(),
  });
});

afterEach(async () => {
  await env.cleanup();
});

// ---------------------------------------------------------------------------
// Validation: HTTP layer adds status codes the UI relies on
// ---------------------------------------------------------------------------
describe('HTTP validation and error codes', () => {
  test('POST /tasks without title returns 400', async () => {
    const { status } = await post('/tasks', { description: 'no title' });
    expect(status).toBe(400);
  });

  test('GET /tasks/:id returns 404 for nonexistent', async () => {
    const { status, body } = await json('/tasks/ghost-id');
    expect(status).toBe(404);
    expect(body.error).toContain('not found');
  });

  test('PATCH /tasks/:id returns 404 for nonexistent', async () => {
    const { status } = await patchReq('/tasks/ghost-id', { title: 'x' });
    expect(status).toBe(404);
  });

  test('DELETE /tasks/:id returns 404 for nonexistent', async () => {
    const { status } = await json('/tasks/ghost-id', { method: 'DELETE' });
    expect(status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Status transition guards: prevents UI from putting tasks in bad states
// ---------------------------------------------------------------------------
describe('status transition validation', () => {
  test('PATCH status to "merged" returns 400', async () => {
    const { body: task } = await post('/tasks', { title: 'Guard test' });
    const { status, body } = await patchReq(`/tasks/${task.id}`, {
      status: 'merged',
    });
    expect(status).toBe(400);
    expect(body.error).toContain('cannot manually set status to merged');
  });

  test('PATCH status to "running" returns 400', async () => {
    const { body: task } = await post('/tasks', { title: 'No run' });
    const { status } = await patchReq(`/tasks/${task.id}`, {
      status: 'running',
    });
    expect(status).toBe(400);
  });

  test('PATCH pending → pending returns 400 (only failed → pending)', async () => {
    const { body: task } = await post('/tasks', { title: 'Already pending' });
    const { status, body } = await patchReq(`/tasks/${task.id}`, {
      status: 'pending',
    });
    expect(status).toBe(400);
    expect(body.error).toContain('can only move failed');
  });

  test('PATCH failed → pending succeeds', async () => {
    const task = await env.taskStore.create({ title: 'Failed' });
    await env.taskStore.updateStatus(task.id, 'failed');

    const { status, body } = await patchReq(`/tasks/${task.id}`, {
      status: 'pending',
    });
    expect(status).toBe(200);
    expect(body.status).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// Task creation with dependencies: POST wires deps correctly
// ---------------------------------------------------------------------------
describe('task creation with deps', () => {
  test('POST /tasks with dependsOn wires deps and returns them', async () => {
    const dep = await env.taskStore.create({ title: 'Dep' });
    await env.stopProcessor();

    const { status, body } = await post('/tasks', {
      title: 'Blocked',
      dependsOn: [dep.id],
    });
    expect(status).toBe(201);
    expect(body.dependsOn).toContain(dep.id);

    // Evaluate is always enqueued (deps gate later workflow steps, not evaluate)
    const jobs = await env.queue.list({ taskId: body.id });
    expect(jobs.length).toBe(1);
    expect(jobs[0]!.type).toBe('evaluate');
  });

  test('POST /tasks with autoRunOverrides persists them', async () => {
    const { body } = await post('/tasks', {
      title: 'Custom autorun',
      autoRunOverrides: { review: false, merge: false },
    });
    const task = await env.taskStore.get(body.id);
    expect(task!.autoRunOverrides).toEqual({ review: false, merge: false });
  });
});

// ---------------------------------------------------------------------------
// Workflow endpoints: approve, request-changes, provide-input
// ---------------------------------------------------------------------------
describe('workflow endpoints', () => {
  test('POST /tasks/:id/approve on non-review task returns 400', async () => {
    const task = await env.taskStore.create({ title: 'Not in review' });
    const { status } = await post(`/tasks/${task.id}/approve`, {});
    expect(status).toBe(400);
  });

  test('POST /tasks/:id/request-changes requires current step', async () => {
    const task = await env.taskStore.create({ title: 'No step' });
    const { status, body } = await post(`/tasks/${task.id}/request-changes`, {
      feedback: 'fix it',
    });
    expect(status).toBe(400);
    expect(body.error).toContain('no current step');
  });

  test('POST /tasks/:id/request-changes requires feedback', async () => {
    const task = await env.taskStore.create({ title: 'In review' });
    await env.taskStore.updateStatus(task.id, 'review');
    const { status, body } = await post(`/tasks/${task.id}/request-changes`, {
      feedback: '',
    });
    expect(status).toBe(400);
    expect(body.error).toContain('feedback');
  });

  test('POST /tasks/:id/input on task w/o pending question returns 400', async () => {
    const task = await env.taskStore.create({ title: 'No question' });
    const { status, body } = await post(`/tasks/${task.id}/input`, {
      answer: 'something',
    });
    expect(status).toBe(400);
    expect(body.error).toContain('no pending question');
  });

  test('POST /tasks/:id/step/run on task without current step returns 400', async () => {
    const task = await env.taskStore.create({ title: 'No step' });
    const { status, body } = await post(`/tasks/${task.id}/step/run`, {});
    expect(status).toBe(400);
    expect(body.error).toContain('no current step');
  });
});

// ---------------------------------------------------------------------------
// Interaction filtering: UI uses query params
// ---------------------------------------------------------------------------
describe('interaction query filtering', () => {
  test('GET /tasks/:id/interactions?type=evaluate filters correctly', async () => {
    const task = await env.taskStore.create({ title: 'Filter' });
    await env.queue.enqueue({ type: 'evaluate', taskId: task.id, priority: 100 });
    await env.waitForIdle(15_000);

    const { body: evalOnly } = await json(
      `/tasks/${task.id}/interactions?type=evaluate`,
    );
    expect(evalOnly.length).toBe(1);
    expect(evalOnly[0].type).toBe('evaluate');

    const { body: all } = await json(`/tasks/${task.id}/interactions`);
    expect(all.length).toBeGreaterThan(1);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Config: PUT /config persists and affects subsequent reads
// ---------------------------------------------------------------------------
describe('config persistence', () => {
  test('PATCH /config patches and subsequent GET reflects changes', async () => {
    const { status } = await patchReq('/config', {
      autoRun: false,
    });
    expect(status).toBe(200);

    const { body } = await json('/config');
    expect(body.autoRun).toBe(false);
  });
});
