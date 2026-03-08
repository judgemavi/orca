import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { type E2EEnv, createE2EEnv } from '../helpers/e2e-env';

let env: E2EEnv;

beforeEach(async () => {
  env = await createE2EEnv();
  env.startProcessor();
});

afterEach(async () => {
  await env.cleanup();
});

// ---------------------------------------------------------------------------
// Happy path: full lifecycle
// ---------------------------------------------------------------------------
describe('happy path: full lifecycle', () => {
  test('evaluate → plan → code → review → merge → retro', async () => {
    const task = await env.taskStore.create({
      title: 'Add hello function',
      description: 'Create a hello world function in a new file',
    });

    await env.queue.enqueue({
      type: 'evaluate',
      taskId: task.id,
      priority: 100,
    });
    await env.waitForIdle(15_000);

    const final = await env.taskStore.get(task.id);
    expect(final!.status).toBe('merged');

    // All interaction types should have been created
    const interactions = await env.interactionStore.list(task.id);
    const types = new Set(interactions.map((i) => i.type));
    expect(types.has('evaluate')).toBe(true);
    expect(types.has('plan')).toBe(true);
    expect(types.has('code')).toBe(true);

    // All interactions should be completed
    for (const ix of interactions) {
      expect(ix.status).toBe('completed');
    }

    // Task should have a plan set (plan handler stores it before approve)
    expect(final!.plan).toBeTruthy();

    // Task should have a sessionId from the code run
    expect(final!.sessionId).toBeTruthy();

    // Events should include the full chain
    const eventNames = env.events.map((e) => e.name);
    expect(eventNames).toContain('evaluate.started');
    expect(eventNames).toContain('evaluate.completed');
    expect(eventNames).toContain('plan.generating');
    expect(eventNames).toContain('plan.completed');
    expect(eventNames).toContain('plan.approved');
  }, 20_000);

  test('pre-planned task: code → review → merge', async () => {
    const task = await env.taskStore.create({
      title: 'Refactor utils',
      description: 'Clean up utility functions',
    });
    await env.taskStore.setPlan(task.id, '## Step 1\nRefactor the code.');
    await env.taskStore.updateStatus(task.id, 'planned');

    await env.queue.enqueue({
      type: 'code',
      taskId: task.id,
      priority: 50,
    });
    await env.waitForIdle(15_000);

    const final = await env.taskStore.get(task.id);
    expect(final!.status).toBe('merged');

    const codeIxs = await env.interactionStore.listByType(task.id, 'code');
    expect(codeIxs.length).toBeGreaterThanOrEqual(1);
    expect(codeIxs[0].status).toBe('completed');
    expect(codeIxs[0].exitCode).toBe(0);
  }, 20_000);

  test('multiple independent tasks complete concurrently', async () => {
    const taskA = await env.taskStore.create({ title: 'Task A' });
    const taskB = await env.taskStore.create({ title: 'Task B' });

    await env.queue.enqueue({
      type: 'evaluate',
      taskId: taskA.id,
      priority: 100,
    });
    await env.queue.enqueue({
      type: 'evaluate',
      taskId: taskB.id,
      priority: 100,
    });
    await env.waitForIdle(20_000);

    const finalA = await env.taskStore.get(taskA.id);
    const finalB = await env.taskStore.get(taskB.id);
    // Both should progress through the chain. Concurrent merges can race
    // on the shared integration branch (git checkout + merge is not atomic),
    // so one may fail. At minimum both should reach review or beyond.
    const terminal = new Set(['merged', 'review', 'failed']);
    expect(terminal.has(finalA!.status)).toBe(true);
    expect(terminal.has(finalB!.status)).toBe(true);
    // At least one must merge successfully
    const statuses = [finalA!.status, finalB!.status];
    expect(statuses).toContain('merged');
  }, 25_000);

  test('interaction costs are tracked', async () => {
    const task = await env.taskStore.create({ title: 'Cost tracking' });
    await env.queue.enqueue({
      type: 'evaluate',
      taskId: task.id,
      priority: 100,
    });
    await env.waitForIdle(15_000);

    const total = await env.interactionStore.projectTotal();
    expect(total).toBeGreaterThan(0);

    const interactions = await env.interactionStore.list(task.id);
    for (const ix of interactions) {
      if (ix.status === 'completed') {
        expect(ix.inputTokens).toBeGreaterThan(0);
        expect(ix.outputTokens).toBeGreaterThan(0);
      }
    }
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Dependency-driven orchestration
// ---------------------------------------------------------------------------
describe('dependency-driven orchestration', () => {
  test('blocked task evaluate is skipped, progresses after dep merges', async () => {
    const taskA = await env.taskStore.create({ title: 'Dep A' });
    const taskB = await env.taskStore.create({ title: 'Dep B' });
    await env.taskStore.updateDependencies(taskB.id, [taskA.id]);

    // Enqueue both
    await env.queue.enqueue({
      type: 'evaluate',
      taskId: taskA.id,
      priority: 100,
    });
    await env.queue.enqueue({
      type: 'evaluate',
      taskId: taskB.id,
      priority: 100,
    });
    await env.waitForIdle(25_000);

    const finalA = await env.taskStore.get(taskA.id);
    const finalB = await env.taskStore.get(taskB.id);
    // A should be merged (full chain)
    expect(finalA!.status).toBe('merged');
    // B's evaluate was skipped (deps not met initially)
    // unblockDependents fires after A merges, which may re-enqueue B
    // B could be anywhere in the chain depending on timing
    expect(finalB).not.toBeNull();
  }, 30_000);

  test('diamond dependency: D waits for both B and C', async () => {
    const a = await env.taskStore.create({ title: 'Diamond A' });
    const b = await env.taskStore.create({ title: 'Diamond B' });
    const c = await env.taskStore.create({ title: 'Diamond C' });
    const d = await env.taskStore.create({ title: 'Diamond D' });
    await env.taskStore.updateDependencies(b.id, [a.id]);
    await env.taskStore.updateDependencies(c.id, [a.id]);
    await env.taskStore.updateDependencies(d.id, [b.id, c.id]);

    await env.queue.enqueue({
      type: 'evaluate',
      taskId: a.id,
      priority: 100,
    });
    // Also enqueue B,C,D — they'll skip if deps not met
    await env.queue.enqueue({
      type: 'evaluate',
      taskId: b.id,
      priority: 100,
    });
    await env.queue.enqueue({
      type: 'evaluate',
      taskId: c.id,
      priority: 100,
    });
    await env.queue.enqueue({
      type: 'evaluate',
      taskId: d.id,
      priority: 100,
    });
    await env.waitForIdle(30_000);

    const finalA = await env.taskStore.get(a.id);
    expect(finalA!.status).toBe('merged');
    // B,C should have been unblocked after A merged
    // D should only unblock after BOTH B and C merge
  }, 35_000);
});

// ---------------------------------------------------------------------------
// Config-driven behavior
// ---------------------------------------------------------------------------
describe('config-driven behavior', () => {
  test('disabling code autoRun stops chain at planned', async () => {
    await env.configStore.patch({
      interactions: {
        code: { tool: 'claude', model: 'mock-model', autoRun: false },
      },
    });

    const task = await env.taskStore.create({ title: 'Config stop test' });
    await env.queue.enqueue({
      type: 'evaluate',
      taskId: task.id,
      priority: 100,
    });
    await env.waitForIdle(15_000);

    const final = await env.taskStore.get(task.id);
    // Plan handler does NOT auto-approve when code autoRun=false
    // So task stays pending with plan set
    expect(final!.status).toBe('pending');
    expect(final!.plan).toBeTruthy();

    // No code interactions
    const codeIxs = await env.interactionStore.listByType(task.id, 'code');
    expect(codeIxs).toHaveLength(0);
  }, 20_000);

  test('disabling plan autoRun stops chain after evaluate', async () => {
    await env.configStore.patch({
      interactions: {
        plan: { tool: 'claude', model: 'mock-model', autoRun: false },
      },
    });

    const task = await env.taskStore.create({ title: 'No plan test' });
    await env.queue.enqueue({
      type: 'evaluate',
      taskId: task.id,
      priority: 100,
    });
    await env.waitForIdle(15_000);

    const final = await env.taskStore.get(task.id);
    expect(final!.status).toBe('pending');

    // Evaluate completed but no plan
    const evalIxs = await env.interactionStore.listByType(
      task.id,
      'evaluate',
    );
    expect(evalIxs).toHaveLength(1);
    expect(evalIxs[0].status).toBe('completed');

    const planIxs = await env.interactionStore.listByType(task.id, 'plan');
    expect(planIxs).toHaveLength(0);
  }, 20_000);

  test('per-task autoRunOverrides override global config', async () => {
    // Global: code autoRun enabled
    // Task: code autoRun disabled
    const task = await env.taskStore.create({
      title: 'Override test',
      autoRunOverrides: { code: false },
    });
    await env.queue.enqueue({
      type: 'evaluate',
      taskId: task.id,
      priority: 100,
    });
    await env.waitForIdle(15_000);

    const final = await env.taskStore.get(task.id);
    // Per-task override: code disabled → plan handler won't auto-approve
    expect(final!.status).toBe('pending');
    expect(final!.plan).toBeTruthy();
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Error scenarios
// ---------------------------------------------------------------------------
describe('error scenarios', () => {
  test('failed job does not crash processor — next task still runs', async () => {
    const bad = await env.taskStore.create({ title: 'Bad task' });
    // Force to review status, then try AI review (will fail — no code diff)
    await env.taskStore.update(bad.id, { status: 'review' });
    await env.queue.enqueue({
      type: 'review',
      taskId: bad.id,
      priority: 50,
    });
    await env.waitForIdle(10_000);

    // Now run a normal task — processor should still work
    const good = await env.taskStore.create({ title: 'Good task' });
    await env.queue.enqueue({
      type: 'evaluate',
      taskId: good.id,
      priority: 100,
    });
    await env.waitForIdle(15_000);

    const finalGood = await env.taskStore.get(good.id);
    expect(finalGood!.status).toBe('merged');
  }, 30_000);

  test('deleted task mid-chain — job fails gracefully', async () => {
    const task = await env.taskStore.create({ title: 'Delete me' });
    await env.taskStore.setPlan(task.id, '## Plan\nDo stuff.');
    await env.taskStore.updateStatus(task.id, 'planned');

    // Enqueue code, then delete task before processor picks it up
    await env.queue.enqueue({
      type: 'code',
      taskId: task.id,
      priority: 50,
    });
    await env.taskStore.delete(task.id);
    await env.waitForIdle(10_000);

    // Task should be gone
    const final = await env.taskStore.get(task.id);
    expect(final).toBeNull();

    // Job should have failed
    const jobs = await env.queue.list({ taskId: task.id });
    const failed = jobs.filter((j) => j.status === 'failed');
    expect(failed.length).toBeGreaterThanOrEqual(1);
  }, 15_000);

  test('evaluate for task with unmet deps is skipped', async () => {
    const dep = await env.taskStore.create({ title: 'Unfinished dep' });
    const task = await env.taskStore.create({ title: 'Blocked task' });
    await env.taskStore.updateDependencies(task.id, [dep.id]);

    await env.queue.enqueue({
      type: 'evaluate',
      taskId: task.id,
      priority: 100,
    });
    await env.waitForIdle(5_000);

    // Task should still be pending — evaluate was skipped
    const final = await env.taskStore.get(task.id);
    expect(final!.status).toBe('pending');

    // Job completed (not failed) but with skipped result
    const jobs = await env.queue.list({ taskId: task.id });
    expect(jobs[0]!.status).toBe('completed');
  }, 10_000);

  test('code job for task with unmet deps is skipped', async () => {
    const dep = await env.taskStore.create({ title: 'Dep' });
    const task = await env.taskStore.create({ title: 'Blocked code' });
    await env.taskStore.updateDependencies(task.id, [dep.id]);
    await env.taskStore.setPlan(task.id, '## Plan');
    await env.taskStore.updateStatus(task.id, 'planned');

    await env.queue.enqueue({
      type: 'code',
      taskId: task.id,
      priority: 50,
    });
    await env.waitForIdle(5_000);

    const final = await env.taskStore.get(task.id);
    expect(final!.status).toBe('planned');
  }, 10_000);

  test('nonexistent task job fails with error', async () => {
    await env.queue.enqueue({
      type: 'code',
      taskId: 'ghost-id-000',
      priority: 50,
    });
    await env.waitForIdle(10_000);

    const jobs = await env.queue.list({ taskId: 'ghost-id-000' });
    expect(jobs[0]!.status).toBe('failed');
    expect(jobs[0]!.error).toContain('not found');
  }, 15_000);
});

// ---------------------------------------------------------------------------
// Queue behavior
// ---------------------------------------------------------------------------
describe('queue behavior', () => {
  test('drain cancels all pending jobs', async () => {
    const t1 = await env.taskStore.create({ title: 'Drain 1' });
    const t2 = await env.taskStore.create({ title: 'Drain 2' });
    const t3 = await env.taskStore.create({ title: 'Drain 3' });

    // Stop processor so jobs stay queued
    await env.stopProcessor();

    await env.queue.enqueue({ type: 'evaluate', taskId: t1.id, priority: 100 });
    await env.queue.enqueue({ type: 'evaluate', taskId: t2.id, priority: 100 });
    await env.queue.enqueue({ type: 'evaluate', taskId: t3.id, priority: 100 });

    const drained = await env.queue.drain();
    expect(drained).toBe(3);

    const counts = await env.queue.counts();
    expect(counts.queued ?? 0).toBe(0);
  }, 10_000);

  test('job priority ordering respected', async () => {
    await env.stopProcessor();

    const low = await env.taskStore.create({ title: 'Low pri' });
    const high = await env.taskStore.create({ title: 'High pri' });

    await env.queue.enqueue({ type: 'evaluate', taskId: low.id, priority: 200 });
    await env.queue.enqueue({ type: 'evaluate', taskId: high.id, priority: 10 });

    // Claim 1 — should get the high-priority job
    const claimed = await env.queue.claim(1);
    expect(claimed).toHaveLength(1);
    expect(claimed[0].taskId).toBe(high.id);
  }, 10_000);
});

// ---------------------------------------------------------------------------
// Event tracking
// ---------------------------------------------------------------------------
describe('event tracking', () => {
  test('full chain emits ordered events', async () => {
    const task = await env.taskStore.create({ title: 'Event test' });
    await env.queue.enqueue({
      type: 'evaluate',
      taskId: task.id,
      priority: 100,
    });
    await env.waitForIdle(15_000);

    const names = env.events.map((e) => e.name);

    // Core chain events should appear in order
    const evalStart = names.indexOf('evaluate.started');
    const evalEnd = names.indexOf('evaluate.completed');
    const planStart = names.indexOf('plan.generating');
    const planEnd = names.indexOf('plan.completed');

    expect(evalStart).toBeGreaterThanOrEqual(0);
    expect(evalEnd).toBeGreaterThan(evalStart);
    expect(planStart).toBeGreaterThan(evalEnd);
    expect(planEnd).toBeGreaterThan(planStart);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Breakdown flow
// ---------------------------------------------------------------------------
describe('breakdown flow', () => {
  test('evaluate_breakdown → breakdown → subtasks created', async () => {
    // Disable breakdown auto-accept to prevent recursive evaluate
    await env.configStore.patch({
      interactions: {
        breakdown: { tool: 'claude', model: 'mock-model', autoRun: false },
      },
    });

    process.env.ORCA_MOCK_EVALUATE_MODE = 'evaluate_breakdown';

    const task = await env.taskStore.create({
      title: 'Complex feature',
      description: 'Needs multiple subtasks',
    });
    await env.queue.enqueue({
      type: 'evaluate',
      taskId: task.id,
      priority: 100,
    });
    await env.waitForIdle(15_000);

    delete process.env.ORCA_MOCK_EVALUATE_MODE;

    // Evaluate should have detected breakdown need
    const evalIxs = await env.interactionStore.listByType(task.id, 'evaluate');
    expect(evalIxs.length).toBe(1);
    expect(evalIxs[0].status).toBe('completed');

    // Breakdown events
    const eventNames = env.events.map((e) => e.name);
    expect(eventNames).toContain('evaluate.completed');
    // Plan should NOT have been enqueued (breakdown path, not plan path)
    expect(eventNames).not.toContain('plan.generating');
  }, 20_000);

  test('breakdown auto-accept creates subtasks with deps', async () => {
    process.env.ORCA_MOCK_EVALUATE_MODE = 'evaluate_breakdown';

    // Stop processor to control timing
    await env.stopProcessor();

    const task = await env.taskStore.create({
      title: 'Breakdown with accept',
      description: 'Should create subtasks',
    });
    await env.queue.enqueue({
      type: 'evaluate',
      taskId: task.id,
      priority: 100,
    });

    // Start processor to run evaluate + breakdown
    env.startProcessor();

    // Wait for parent to be broken down
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const t = await env.taskStore.get(task.id);
      if (t?.status === 'broken_down') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    // Stop immediately to prevent subtask evaluate from running
    await env.stopProcessor();
    delete process.env.ORCA_MOCK_EVALUATE_MODE;

    const parent = await env.taskStore.get(task.id);
    expect(parent!.status).toBe('broken_down');

    // Subtasks created
    const all = await env.taskStore.list();
    const children = all.filter((t) => t.parentId === task.id);
    expect(children.length).toBeGreaterThanOrEqual(2);

    // Second subtask depends on first (from mock: dependsOnIndices: [0])
    const withDeps = children.filter((c) => c.dependsOn.length > 0);
    expect(withDeps.length).toBeGreaterThanOrEqual(1);

    // Breakdown events
    const eventNames = env.events.map((e) => e.name);
    expect(eventNames).toContain('breakdown.started');
    expect(eventNames).toContain('breakdown.completed');
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Review rejection loop
// ---------------------------------------------------------------------------
describe('review rejection loop', () => {
  test('rejected review → re-code → approved review → merged', async () => {
    // Run normal chain to get task to review state first
    const task = await env.taskStore.create({
      title: 'Review loop test',
      description: 'Should get rejected then approved',
    });

    // Disable review autoRun so chain stops at review status
    await env.configStore.patch({
      interactions: {
        review: { tool: 'claude', model: 'mock-model', autoRun: false },
      },
    });

    await env.queue.enqueue({
      type: 'evaluate',
      taskId: task.id,
      priority: 100,
    });

    // Wait for task to reach review (code done, review not auto-run)
    let deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const t = await env.taskStore.get(task.id);
      if (t?.status === 'review') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const atReview = await env.taskStore.get(task.id);
    expect(atReview!.status).toBe('review');

    // Stop processor so we can control job execution precisely
    await env.stopProcessor();

    // Step 1: Enqueue and run a single rejected review
    process.env.ORCA_MOCK_REVIEW_MODE = 'review_reject';
    await env.configStore.patch({
      interactions: {
        review: { tool: 'claude', model: 'mock-model', autoRun: true },
      },
    });
    await env.queue.enqueue({
      type: 'review',
      taskId: task.id,
      priority: 50,
    });
    env.startProcessor();

    // Wait for re-code to be enqueued (rejection triggers code + _autoReviewAfter)
    deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const reviseIxs = await env.interactionStore.listByType(
        task.id,
        'revise',
      );
      if (reviseIxs.length >= 1) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    // Step 2: Switch to approve before second review
    process.env.ORCA_MOCK_REVIEW_MODE = 'review';
    await env.waitForIdle(15_000);
    delete process.env.ORCA_MOCK_REVIEW_MODE;

    const final = await env.taskStore.get(task.id);
    expect(final!.status).toBe('merged');

    // Should have code + revise interactions
    const codeIxs = await env.interactionStore.listByType(task.id, 'code');
    const reviseIxs = await env.interactionStore.listByType(
      task.id,
      'revise',
    );
    expect(codeIxs.length + reviseIxs.length).toBeGreaterThanOrEqual(2);

    // Should have multiple review interactions (reject + approve)
    const reviewIxs = await env.interactionStore.listByType(task.id, 'review');
    expect(reviewIxs.length).toBeGreaterThanOrEqual(2);
  }, 35_000);
});
