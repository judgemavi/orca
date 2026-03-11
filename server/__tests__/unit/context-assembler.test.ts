import { describe, expect, test } from 'bun:test';
import { createTestContext } from '../helpers/db';
import {
  assembleConsumedContext,
  getStepOutput,
  hasStepOutput,
} from '../../src/workflow/context';

describe('getStepOutput', () => {
  test('returns empty string when no interactions exist', async () => {
    const ctx = createTestContext();
    const task = await ctx.taskStore.create({ title: 'Test' });
    const result = await getStepOutput(task.id, 'plan', ctx.interactionStore);
    expect(result).toBe('');
    ctx.close();
  });

  test('extracts plan from output data', async () => {
    const ctx = createTestContext();
    const task = await ctx.taskStore.create({ title: 'Test' });
    const ix = await ctx.interactionStore.begin({
      taskId: task.id,
      type: 'context',
      stepName: 'plan',
      tool: 'test',
    });
    await ctx.interactionStore.finish(ix.id, {
      status: 'completed',
      output: JSON.stringify({ result: 'approved', output: '## Step 1\nDo things' }),
    });
    const result = await getStepOutput(task.id, 'plan', ctx.interactionStore);
    expect(result).toBe('## Step 1\nDo things');
    ctx.close();
  });

  test('extracts diff from code interaction output', async () => {
    const ctx = createTestContext();
    const task = await ctx.taskStore.create({ title: 'Test' });
    const ix = await ctx.interactionStore.begin({
      taskId: task.id,
      type: 'code',
      stepName: 'code',
      tool: 'test',
    });
    await ctx.interactionStore.finish(ix.id, {
      status: 'completed',
      output: JSON.stringify({ result: 'success', output: '--- a/file.ts\n+++ b/file.ts\n+new line' }),
    });
    const result = await getStepOutput(task.id, 'code', ctx.interactionStore);
    expect(result).toContain('+new line');
    ctx.close();
  });

  test('extracts output field from data', async () => {
    const ctx = createTestContext();
    const task = await ctx.taskStore.create({ title: 'Test' });
    const ix = await ctx.interactionStore.begin({
      taskId: task.id,
      type: 'context',
      stepName: 'custom_step',
      tool: 'test',
    });
    await ctx.interactionStore.finish(ix.id, {
      status: 'completed',
      output: JSON.stringify({ result: 'success', output: 'custom result' }),
    });
    const result = await getStepOutput(
      task.id,
      'custom_step',
      ctx.interactionStore,
    );
    expect(result).toBe('custom result');
    ctx.close();
  });

  test('ignores non-completed interactions', async () => {
    const ctx = createTestContext();
    const task = await ctx.taskStore.create({ title: 'Test' });
    await ctx.interactionStore.begin({
      taskId: task.id,
      type: 'context',
      stepName: 'plan',
      tool: 'test',
    });
    // interaction is still "running", not completed
    const result = await getStepOutput(task.id, 'plan', ctx.interactionStore);
    expect(result).toBe('');
    ctx.close();
  });
});

describe('hasStepOutput', () => {
  test('returns false when no completed interaction', async () => {
    const ctx = createTestContext();
    const task = await ctx.taskStore.create({ title: 'Test' });
    expect(
      await hasStepOutput(task.id, 'plan', ctx.interactionStore),
    ).toBe(false);
    ctx.close();
  });

  test('returns true when completed interaction exists', async () => {
    const ctx = createTestContext();
    const task = await ctx.taskStore.create({ title: 'Test' });
    const ix = await ctx.interactionStore.begin({
      taskId: task.id,
      type: 'decision',
      stepName: 'review',
      tool: 'test',
    });
    await ctx.interactionStore.finish(ix.id, { status: 'completed' });
    expect(
      await hasStepOutput(task.id, 'review', ctx.interactionStore),
    ).toBe(true);
    ctx.close();
  });
});

describe('assembleConsumedContext', () => {
  test('returns empty string for no consumes', async () => {
    const ctx = createTestContext();
    const result = await assembleConsumedContext({
      taskId: 'test',
      consumes: [],
      interactionStore: ctx.interactionStore,
    });
    expect(result).toBe('');
    ctx.close();
  });

  test('assembles multiple step outputs with separators', async () => {
    const ctx = createTestContext();
    const task = await ctx.taskStore.create({ title: 'Test' });

    // Plan interaction
    const planIx = await ctx.interactionStore.begin({
      taskId: task.id,
      type: 'context',
      stepName: 'plan',
      tool: 'test',
    });
    await ctx.interactionStore.finish(planIx.id, {
      status: 'completed',
      output: JSON.stringify({ result: 'approved', output: 'the plan' }),
    });

    // Code interaction
    const codeIx = await ctx.interactionStore.begin({
      taskId: task.id,
      type: 'code',
      stepName: 'code',
      tool: 'test',
    });
    await ctx.interactionStore.finish(codeIx.id, {
      status: 'completed',
      output: JSON.stringify({ result: 'success', output: 'the diff' }),
    });

    const result = await assembleConsumedContext({
      taskId: task.id,
      consumes: ['plan', 'code'],
      interactionStore: ctx.interactionStore,
    });

    expect(result).toContain('## Output from: plan');
    expect(result).toContain('the plan');
    expect(result).toContain('## Output from: code');
    expect(result).toContain('the diff');
    expect(result).toContain('---');
    ctx.close();
  });

  test('skips steps with no output', async () => {
    const ctx = createTestContext();
    const task = await ctx.taskStore.create({ title: 'Test' });

    const result = await assembleConsumedContext({
      taskId: task.id,
      consumes: ['plan', 'code'],
      interactionStore: ctx.interactionStore,
    });

    expect(result).toBe('');
    ctx.close();
  });

  test('resolves dotted step names (loop scoped)', async () => {
    const ctx = createTestContext();
    const task = await ctx.taskStore.create({ title: 'Test' });

    // Interaction stored with dotted stepName
    const ix = await ctx.interactionStore.begin({
      taskId: task.id,
      type: 'code',
      stepName: 'implement.code',
      tool: 'test',
    });
    await ctx.interactionStore.finish(ix.id, {
      status: 'completed',
      output: JSON.stringify({ result: 'success', output: 'code output' }),
    });

    const result = await assembleConsumedContext({
      taskId: task.id,
      consumes: ['implement.code'],
      interactionStore: ctx.interactionStore,
    });

    expect(result).toContain('## Output from: implement.code');
    expect(result).toContain('code output');
    ctx.close();
  });
});
