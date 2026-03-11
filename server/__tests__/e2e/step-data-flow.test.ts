import { describe, expect, test } from 'bun:test';
import { type E2EEnv, setupE2EEnv } from '../helpers/e2e-env';

const env = setupE2EEnv();

function capturesByMode(env: E2EEnv) {
  const map = new Map<string, string[]>();
  for (const { mode, prompt } of env.mockPlugin.captures) {
    const list = map.get(mode) ?? [];
    list.push(prompt);
    map.set(mode, list);
  }
  return map;
}

describe('step data flow: output format + context propagation', () => {
  test('each step produces { result, output } and next step receives consumed context', async () => {
    const task = await env.taskStore.create({
      title: 'Data flow test',
      description: 'Verify step outputs and context propagation',
    });

    await env.queue.enqueue({
      type: 'evaluate',
      taskId: task.id,
      priority: 100,
    });
    await env.waitForIdle(15_000);

    const final = await env.taskStore.get(task.id);
    expect(final!.status).toBe('merged');

    // ---------------------------------------------------------------
    // 1. Verify interaction output format: { result, output } — no nested data
    // ---------------------------------------------------------------
    const interactions = await env.interactionStore.list(task.id);
    const byStepName = new Map(interactions.map((ix) => [ix.stepName, ix]));

    // Plan: LLM step (type=context) with branches { done }
    const planIx = byStepName.get('plan');
    expect(planIx).toBeTruthy();
    expect(planIx!.status).toBe('completed');
    const planOutput = JSON.parse(planIx!.output!) as Record<string, unknown>;
    expect(planOutput.result).toBe('done');
    expect(typeof planOutput.output).toBe('string');
    expect(planOutput.output).toContain('Implementation Plan');
    expect(planOutput).not.toHaveProperty('data');

    // Review: LLM step (type=decision) with branches { approved, request_changes }
    const reviewIx = byStepName.get('implement.review');
    expect(reviewIx).toBeTruthy();
    expect(reviewIx!.status).toBe('completed');
    const reviewOutput = JSON.parse(reviewIx!.output!) as Record<
      string,
      unknown
    >;
    expect(reviewOutput.result).toBe('approved');
    expect(typeof reviewOutput.output).toBe('string');
    expect(reviewOutput).not.toHaveProperty('data');

    // ---------------------------------------------------------------
    // 2. Verify prompts: static prompt present + consumed context injected
    // ---------------------------------------------------------------
    const captures = capturesByMode(env);

    // Evaluate: static evaluate prompt
    expect(captures.has('evaluate')).toBe(true);
    const evalPrompt = captures.get('evaluate')![0]!;
    expect(evalPrompt).toContain('task complexity evaluator');

    // Plan: static plan prompt, no consumed context (plan has no consumes)
    expect(captures.has('plan')).toBe(true);
    const planPrompt = captures.get('plan')![0]!;
    expect(planPrompt).toContain('implementation planner');
    expect(planPrompt).not.toContain('Output from:');

    // Code: consumed plan output in context
    expect(captures.has('code')).toBe(true);
    const codePrompt = captures.get('code')![0]!;
    expect(codePrompt).toContain('Output from: plan');
    expect(codePrompt).toContain('Implementation Plan');

    // Review: static review prompt + consumed plan output
    // (code type is filtered from review consumes — review gets diff via executor)
    expect(captures.has('review')).toBe(true);
    const reviewPrompt = captures.get('review')![0]!;
    expect(reviewPrompt).toContain('code reviewer');
    expect(reviewPrompt).toContain('Output from: plan');
    expect(reviewPrompt).toContain('Implementation Plan');

    // ---------------------------------------------------------------
    // 3. Verify ordering: evaluate → plan → code → review
    // ---------------------------------------------------------------
    const modes = env.mockPlugin.captures.map((c) => c.mode);
    const evalIdx = modes.indexOf('evaluate');
    const planIdx = modes.indexOf('plan');
    const codeIdx = modes.indexOf('code');
    const reviewIdx = modes.indexOf('review');
    expect(evalIdx).toBeLessThan(planIdx);
    expect(planIdx).toBeLessThan(codeIdx);
    expect(codeIdx).toBeLessThan(reviewIdx);
  }, 20_000);

  test('review rejection: code retry receives review feedback', async () => {
    const task = await env.taskStore.create({
      title: 'Feedback flow test',
      description: 'Verify review feedback reaches code on retry',
    });

    // Disable review autoRun so chain pauses at review
    await env.taskStore.update(task.id, {
      autoRunOverrides: { 'implement.review': false },
    });

    await env.queue.enqueue({
      type: 'evaluate',
      taskId: task.id,
      priority: 100,
    });

    // Wait for review gate
    let deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const t = await env.taskStore.get(task.id);
      if (t?.currentStep === 'implement.review') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const atReview = await env.taskStore.get(task.id);
    expect(atReview!.currentStep).toBe('implement.review');

    await env.stopProcessor();

    // Clear captures from initial chain
    env.mockPlugin.captures.length = 0;

    // Run rejected review
    process.env.ORCA_MOCK_REVIEW_MODE = 'review_reject';
    await env.taskStore.update(task.id, { autoRunOverrides: {} });
    await env.queue.enqueue({
      type: 'implement.review',
      taskId: task.id,
      priority: 50,
    });
    env.startProcessor();

    // Wait for second code run
    deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const codeIxs = await env.interactionStore.listByStepName(task.id, 'implement.code');
      if (codeIxs.length >= 2) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    // Switch to approve
    process.env.ORCA_MOCK_REVIEW_MODE = 'review';
    await env.waitForIdle(15_000);
    delete process.env.ORCA_MOCK_REVIEW_MODE;

    const final = await env.taskStore.get(task.id);
    expect(final!.status).toBe('merged');

    // Verify: code retry received review feedback
    // Code retry uses resumeArgs (session resume), so mode is 'resume'
    const resumeCaptures = env.mockPlugin.captures.filter(
      (c) => c.mode === 'resume',
    );
    expect(resumeCaptures.length).toBeGreaterThanOrEqual(1);
    // Review rejection output: "Missing error handling in the main function."
    const retryFeedback = resumeCaptures[0]!.prompt;
    expect(retryFeedback).toContain('Missing error handling');
  }, 35_000);
});
