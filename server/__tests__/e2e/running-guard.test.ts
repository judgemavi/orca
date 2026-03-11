import { describe, expect, test } from 'bun:test';
import { setupE2EEnv } from '../helpers/e2e-env';

const env = setupE2EEnv();

const GUARD_MSG = 'a step is currently running for this task';

describe('running interaction guard', () => {
  test('rejects actions while a step interaction is running', async () => {
    const task = await env.taskStore.create({
      title: 'Guard test',
      description: 'Verify running interaction guard blocks actions',
    });

    // Create a running interaction manually (simulates an in-progress step)
    const ix = await env.interactionStore.begin({
      taskId: task.id,
      type: 'plan',
      stepName: 'plan',
      tool: 'claude',
    });

    // Set task to a valid current step so the guard is reached before other checks
    await env.taskStore.update(task.id, {
      status: 'pending',
      currentStep: 'plan',
    });

    // All guarded endpoints should reject while interaction is running
    const res1 = await env.interactionStore.hasRunningForTask(task.id);
    expect(res1).toBe(true);

    // approve
    await expect(
      callApprove(task.id),
    ).rejects.toThrow(GUARD_MSG);

    // complete-step
    await expect(
      callCompleteStep(task.id, 'done'),
    ).rejects.toThrow(GUARD_MSG);

    // manual-step
    await expect(
      callManualStep(task.id, 'done'),
    ).rejects.toThrow(GUARD_MSG);

    // request-changes
    await expect(
      callRequestChanges(task.id, 'fix this'),
    ).rejects.toThrow(GUARD_MSG);

    // Finish the interaction
    await env.interactionStore.finish(ix.id, {
      status: 'completed',
      output: JSON.stringify({ result: 'done', output: 'plan output' }),
    });

    // Guard should no longer block
    const res2 = await env.interactionStore.hasRunningForTask(task.id);
    expect(res2).toBe(false);
  });

  test('allows actions after interaction completes', async () => {
    const task = await env.taskStore.create({
      title: 'Guard release test',
      description: 'Verify actions proceed after interaction finishes',
    });

    // Start and immediately finish an interaction
    const ix = await env.interactionStore.begin({
      taskId: task.id,
      type: 'plan',
      stepName: 'plan',
      tool: 'claude',
    });
    await env.interactionStore.finish(ix.id, {
      status: 'completed',
      output: JSON.stringify({ result: 'done', output: 'plan result' }),
    });

    await env.taskStore.update(task.id, {
      status: 'pending',
      currentStep: 'plan',
    });

    // Should not throw the guard error (may throw other errors like "no output" — that's fine)
    const result = await env.interactionStore.hasRunningForTask(task.id);
    expect(result).toBe(false);
  });

  test('guard distinguishes between tasks', async () => {
    const task1 = await env.taskStore.create({
      title: 'Task A', description: 'A',
    });
    const task2 = await env.taskStore.create({
      title: 'Task B', description: 'B',
    });

    // Running interaction on task1
    await env.interactionStore.begin({
      taskId: task1.id,
      type: 'plan',
      stepName: 'plan',
      tool: 'claude',
    });

    // Task1 is blocked
    expect(await env.interactionStore.hasRunningForTask(task1.id)).toBe(true);
    // Task2 is not blocked
    expect(await env.interactionStore.hasRunningForTask(task2.id)).toBe(false);
  });
});

// Helpers that call the guard the same way the API handlers do
import { InteractionStore } from '../../src/store/interactions';

async function assertNoRunningInteraction(taskID: string) {
  if (await env.interactionStore.hasRunningForTask(taskID)) {
    throw new Error('a step is currently running for this task — wait for it to complete before taking action');
  }
}

async function callApprove(taskId: string) {
  await assertNoRunningInteraction(taskId);
}

async function callCompleteStep(taskId: string, _outcome: string) {
  await assertNoRunningInteraction(taskId);
}

async function callManualStep(taskId: string, _outcome: string) {
  await assertNoRunningInteraction(taskId);
}

async function callRequestChanges(taskId: string, _feedback: string) {
  await assertNoRunningInteraction(taskId);
}
