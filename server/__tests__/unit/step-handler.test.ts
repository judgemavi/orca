import { describe, expect, test } from 'bun:test';
import { createMachine } from 'xstate';
import { JobProcessor } from '../../src/queue/processor';
import { parseStepOutcome, resolveConsumeName } from '../../src/queue/step-handler';
import { createTestDB } from '../helpers/db';
import { JobQueue } from '../../src/queue/queue';
import type { StepMeta } from '../../src/workflow/types';
import type { CompiledWorkflow } from '../../src/workflow/types';
import { buildTransitionMeta } from '../../src/workflow/paths';
import { createTask } from '../../src/store/tasks';

function makeCompiled(machine: ReturnType<typeof createMachine>, name: string): CompiledWorkflow {
  return { machine, name, transitionMeta: buildTransitionMeta(machine) };
}

describe('parseStepOutcome', () => {
  test('extracts outcome from JSON code block', () => {
    const branchNames = ['approved', 'rejected'];
    const text = 'Some preamble\n```json\n{"result":"approved","output":"looks good"}\n```';
    const result = parseStepOutcome(text, branchNames);
    expect(result.outcome).toBe('approved');
    expect(result.output).toBe('looks good');
  });

  test('extracts outcome from legacy outcome key', () => {
    const branchNames = ['approved', 'rejected'];
    const text = 'Analysis\n```json\n{"outcome":"approved","output":"looks good"}\n```';
    const result = parseStepOutcome(text, branchNames);
    expect(result.outcome).toBe('approved');
    expect(result.output).toBe('looks good');
  });

  test('extracts outcome from inline JSON', () => {
    const branchNames = ['success', 'fail'];
    const text = 'Result: {"outcome": "fail", "reason": "tests failed"}';
    const result = parseStepOutcome(text, branchNames);
    expect(result.outcome).toBe('fail');
  });

  test('falls back to keyword scan', () => {
    const branchNames = ['approved', 'rejected'];
    const text = 'After review, this is APPROVED with no issues.';
    const result = parseStepOutcome(text, branchNames);
    expect(result.outcome).toBe('approved');
  });

  test('defaults to first branch when no match', () => {
    const branchNames = ['alpha', 'beta'];
    const text = 'Nothing recognizable here.';
    const result = parseStepOutcome(text, branchNames);
    expect(result.outcome).toBe('alpha');
  });

  test('fenced JSON extracts outcome and uses text before fence as output', () => {
    const branchNames = ['approved', 'rejected'];
    const prose = 'Here is the plan.\n\nStep 1: do stuff.\nStep 2: verify.';
    const fenced = '\n\n```json\n{"result":"approved","output":"all good"}\n```';
    const text = prose + fenced;
    const result = parseStepOutcome(text, branchNames);
    expect(result.outcome).toBe('approved');
    expect(result.output).toBe('all good');
  });

  test('ignores invalid JSON in code block', () => {
    const branchNames = ['success', 'fail'];
    const text = '```json\n{bad json}\n```\nSome text mentioning fail somewhere.';
    const result = parseStepOutcome(text, branchNames);
    expect(result.outcome).toBe('fail');
  });

  // Backward compat: also accepts old WorkflowStepDef-like object with branches
  test('accepts object with branches property', () => {
    const stepDef = { branches: { approved: { next: 'x' }, rejected: { next: 'y' } } };
    const text = 'All looks REJECTED.';
    const result = parseStepOutcome(text, stepDef as any);
    expect(result.outcome).toBe('rejected');
  });
});

describe('dotted step resolution', () => {
  const loopMachine = createMachine({
    id: 'test',
    initial: 'plan',
    states: {
      plan: {
        meta: { type: 'context', executor: 'tool', prompt: 'plan', autoRun: true } as StepMeta,
        on: { done: 'impl' },
      },
      impl: {
        meta: { maxIterations: 3 } as StepMeta,
        initial: 'code',
        states: {
          code: {
            meta: { type: 'code', executor: 'tool', prompt: 'code' } as StepMeta,
            on: { ok: 'review' },
          },
          review: {
            meta: { type: 'decision', executor: 'tool', prompt: 'review', consumes: ['code'] } as StepMeta,
            on: { approved: '#test.finish' },
          },
        },
      },
      finish: { type: 'final' as const },
    },
  });
  const compiled = makeCompiled(loopMachine, 'test');

  test('resolves dotted stepName to correct meta', () => {
    const { meta } = require('../../src/workflow/paths').resolveStepMeta(compiled.machine, 'impl.code');
    expect(meta.type).toBe('code');
  });

  test('bare consumes name resolves to sibling in loop scope', () => {
    const resolved = resolveConsumeName('code', 'impl.review', compiled);
    expect(resolved).toBe('impl.code');
  });

  test('bare consumes name falls through to outer scope', () => {
    const resolved = resolveConsumeName('plan', 'impl.review', compiled);
    expect(resolved).toBe('plan');
  });
});

describe('JobProcessor fallback', () => {
  test('fallback handler is called for unregistered job types', async () => {
    const testDB = createTestDB();
    const queue = new JobQueue(testDB.db);
    const called: string[] = [];

    const processor = new JobProcessor({
      queue,
      maxParallel: 1,
    });

    processor.setFallback(async (job) => {
      called.push(job.type);
      return { handled: true };
    });

    await createTask(testDB.db, undefined, { id: 'test-1', title: 'Test task' });
    await queue.enqueue({ type: 'custom_step' as 'evaluate', taskId: 'test-1', priority: 10 });

    processor.start();

    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && called.length === 0) {
      await new Promise((r) => setTimeout(r, 50));
    }
    await processor.stop();
    testDB.close();

    expect(called).toContain('custom_step');
  });

  test('explicit handler takes priority over fallback', async () => {
    const testDB = createTestDB();
    const queue = new JobQueue(testDB.db);
    const explicitCalled: string[] = [];
    const fallbackCalled: string[] = [];

    const processor = new JobProcessor({
      queue,
      maxParallel: 1,
    });

    processor.register('evaluate', async (job) => {
      explicitCalled.push(job.type);
    });

    processor.setFallback(async (job) => {
      fallbackCalled.push(job.type);
    });

    await createTask(testDB.db, undefined, { id: 'test-1', title: 'Test task' });
    await queue.enqueue({ type: 'evaluate', taskId: 'test-1', priority: 10 });

    processor.start();
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && explicitCalled.length === 0) {
      await new Promise((r) => setTimeout(r, 50));
    }
    await processor.stop();
    testDB.close();

    expect(explicitCalled).toContain('evaluate');
    expect(fallbackCalled).toHaveLength(0);
  });

  test('job fails when no handler and no fallback', async () => {
    const testDB = createTestDB();
    const queue = new JobQueue(testDB.db);

    const processor = new JobProcessor({
      queue,
      maxParallel: 1,
    });

    await createTask(testDB.db, undefined, { id: 'test-1', title: 'Test task' });
    await queue.enqueue({ type: 'unknown_type' as 'evaluate', taskId: 'test-1', priority: 10 });

    processor.start();
    await new Promise((r) => setTimeout(r, 500));
    await processor.stop();

    const jobs = await queue.list({ taskId: 'test-1' });
    expect(jobs[0]?.status).toBe('failed');
    expect(jobs[0]?.error).toContain('no handler registered');

    testDB.close();
  });
});
