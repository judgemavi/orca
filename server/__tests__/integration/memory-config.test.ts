import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { type E2EEnv, createE2EEnv } from '../helpers/e2e-env';
import { buildRoutes } from '../../src/api/routes';
import { EmbeddingRegistry } from '../../src/embedding/registry';
import { WorkflowStore } from '../../src/workflow/store';
import { JOB_PRIORITIES } from '@orca/types';

let env: E2EEnv;

beforeEach(async () => {
  env = await createE2EEnv();
});

afterEach(async () => {
  await env.cleanup();
});

// ---------------------------------------------------------------------------
// Queue handler: retro skips when memory disabled
// ---------------------------------------------------------------------------
describe('queue handler memory gating', () => {
  test('retro handler skips when memory.enabled=false', async () => {
    await env.configStore.patch({ memory: { enabled: false } });

    const task = await env.taskStore.create({ title: 'test' });
    await env.queue.enqueue({
      type: 'retro',
      taskId: task.id,
      priority: JOB_PRIORITIES.retro,
    });

    env.startProcessor();
    // Wait for job to complete
    await new Promise((r) => setTimeout(r, 500));
    await env.stopProcessor();

    const counts = await env.queue.counts();
    expect(counts.queued ?? 0).toBe(0);
    expect(counts.failed ?? 0).toBe(0);
    // No retro.started event since it was skipped
    expect(env.events.some((e) => e.name === 'retro.started')).toBe(false);
  });

  test('explore handler skips when memory.enabled=false', async () => {
    await env.configStore.patch({ memory: { enabled: false } });

    await env.queue.enqueue({
      type: 'explore',
      priority: JOB_PRIORITIES.explore,
    });

    env.startProcessor();
    await new Promise((r) => setTimeout(r, 500));
    await env.stopProcessor();

    const counts = await env.queue.counts();
    expect(counts.queued ?? 0).toBe(0);
    expect(counts.failed ?? 0).toBe(0);
    expect(env.events.some((e) => e.name === 'explore.started')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// HTTP API: POST /memory/explore returns 400 when memory disabled
// ---------------------------------------------------------------------------
describe('HTTP explore memory gating', () => {
  test('POST /memory/explore returns 400 when memory.enabled=false', async () => {
    await env.configStore.patch({ memory: { enabled: false } });

    const app = buildRoutes({
      db: env.conn.db,
      repoDir: env.repoDir,
      interactionStore: env.interactionStore,
      memoryStore: env.memoryStore,
      registry: env.registry,
      embeddingRegistry: new EmbeddingRegistry(false),
      executor: env.executor,
      eventSink: env.sink,
      queue: env.queue,
      workflowStore: new WorkflowStore(),
    });

    const res = await app.request('/api/v1/memory/explore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, any>;
    expect(body.error).toContain('memory is disabled');
  });
});
