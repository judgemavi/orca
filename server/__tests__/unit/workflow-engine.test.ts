import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { AnyStateMachine } from 'xstate';
import type { OrcaDrizzleDB } from '../../src/db/connection';
import { JobQueue } from '../../src/queue/queue';
import { createTask, getTask } from '../../src/store/tasks';
import {
  completeStep,
  initWorkflow,
  joinPath,
  parsePath,
  resumeUnblockedTask,
  resolveStepMeta,
} from '../../src/workflow/engine';
import type { WorkflowEngineDeps } from '../../src/workflow/engine';
import { WorkflowStore } from '../../src/workflow/store';
import type { CompiledWorkflow, StepMeta, TransitionMeta, WorkflowMeta } from '../../src/workflow/types';
import { buildTransitionMeta } from '../../src/workflow/paths';
import { createWorkflowMachine } from '../../src/workflow/presets';
import { createTestDB } from '../helpers/db';
import * as questionStoreFns from '../../src/store/questions';
import { InteractionStore } from '../../src/store/interactions';

let closeFn: () => void;
let deps: WorkflowEngineDeps;
let queue: JobQueue;
let db: OrcaDrizzleDB;

function makeCompiled(machine: AnyStateMachine, name: string): CompiledWorkflow {
  return { machine, name, transitionMeta: buildTransitionMeta(machine) };
}

// ---------------------------------------------------------------------------
// Test workflow definitions
// ---------------------------------------------------------------------------

const simpleMachine = createWorkflowMachine('test-simple', {
  initial: 'step_a',
  states: {
    step_a: {
      meta: { type: 'context', executor: 'tool', prompt: 'a', maxIterations: 3 } as StepMeta,
      entry: { type: 'incrementIteration', params: { stepPath: 'step_a' } },
      on: {
        success: 'step_b',
        fail: {
          target: 'step_a',
          reenter: true,
          guard: { type: 'withinIterationLimit', params: { stepPath: 'step_a', max: 3 } },
          meta: { includeOutput: false } as TransitionMeta,
        },
      },
    },
    step_b: {
      meta: { type: 'gate', executor: 'none' } as StepMeta,
      on: {
        approved: 'finish',
        rejected: { target: 'step_a', meta: { includeOutput: true } as TransitionMeta },
      },
    },
    finish: { type: 'final' as const },
  },
});

// Loop workflow: plan → implement(code→review→exit) → merge → finish
const loopMachine = createWorkflowMachine('test-loop', {
  initial: 'plan',
  states: {
    plan: {
      meta: { type: 'context', executor: 'tool', prompt: 'plan', autoRun: true } as StepMeta,
      entry: { type: 'incrementIteration', params: { stepPath: 'plan' } },
      on: { done: 'implement' },
    },
    implement: {
      meta: { maxIterations: 3 } as StepMeta,
      initial: 'code',
      states: {
        code: {
          meta: { type: 'code', executor: 'tool', prompt: 'code', autoRun: true, maxIterations: 3 } as StepMeta,
          entry: { type: 'incrementIteration', params: { stepPath: 'implement.code' } },
          on: {
            success: 'review',
            fail: {
              target: 'code',
              reenter: true,
              guard: { type: 'withinIterationLimit', params: { stepPath: 'implement.code', max: 3 } },
            },
          },
        },
        review: {
          meta: { type: 'decision', executor: 'tool', prompt: 'review', autoRun: true, maxIterations: 3 } as StepMeta,
          entry: { type: 'incrementIteration', params: { stepPath: 'implement.review' } },
          on: {
            approved: '#test-loop.merge',
            request_changes: {
              target: 'code',
              guard: { type: 'withinIterationLimit', params: { stepPath: 'implement.code', max: 3 } },
              meta: { includeOutput: true } as TransitionMeta,
            },
          },
        },
      },
    },
    merge: {
      meta: { type: 'merge', autoRun: true } as StepMeta,
      entry: { type: 'incrementIteration', params: { stepPath: 'merge' } },
      on: { success: 'finish' },
    },
    finish: { type: 'final' as const },
  },
});

// Loop with compound maxIterations gate (loop.step can retry internally)
const exhaustedGateMachine = createWorkflowMachine('test-exhausted-gate', {
  initial: 'loop',
  states: {
    loop: {
      meta: { maxIterations: 2 } as StepMeta,
      initial: 'step',
      states: {
        step: {
          meta: { type: 'context', executor: 'tool', prompt: 'step', autoRun: true } as StepMeta,
          entry: { type: 'incrementIteration', params: { stepPath: 'loop.step' } },
          on: {
            ok: '#test-exhausted-gate.finish',
            retry: {
              target: 'step',
              reenter: true,
              guard: { type: 'withinIterationLimit', params: { stepPath: 'loop.step', max: 2 } },
            },
          },
        },
      },
    },
    finish: { type: 'final' as const },
  },
});

// Nested loop: outer(inner(code→exit)→check→exit) → finish
const nestedLoopMachine = createWorkflowMachine('test-nested', {
  initial: 'outer',
  states: {
    outer: {
      meta: { maxIterations: 2 } as StepMeta,
      initial: 'inner',
      states: {
        inner: {
          meta: { maxIterations: 3 } as StepMeta,
          initial: 'code',
          states: {
            code: {
              meta: { type: 'code', executor: 'tool', prompt: 'code', autoRun: true } as StepMeta,
              entry: { type: 'incrementIteration', params: { stepPath: 'outer.inner.code' } },
              on: { done: '#test-nested.outer.check' },
            },
          },
        },
        check: {
          meta: { type: 'decision', executor: 'tool', prompt: 'check', autoRun: true } as StepMeta,
          entry: { type: 'incrementIteration', params: { stepPath: 'outer.check' } },
          on: {
            pass: '#test-nested.finish',
            retry: 'inner',
          },
        },
      },
    },
    finish: { type: 'final' as const },
  },
});

// Nested loop exit bubble through outer: outer(inner(code→exit outer)) → finish
const nestedLoopExitMachine = createWorkflowMachine('test-nested-exit-failure', {
  initial: 'outer',
  states: {
    outer: {
      initial: 'inner',
      states: {
        inner: {
          initial: 'code',
          states: {
            code: {
              meta: { type: 'code', executor: 'tool', prompt: 'code', autoRun: true } as StepMeta,
              entry: { type: 'incrementIteration', params: { stepPath: 'outer.inner.code' } },
              on: { done: '#test-nested-exit-failure.finish' },
            },
          },
        },
      },
    },
    finish: { type: 'final' as const },
  },
});

beforeEach(async () => {
  const testDB = createTestDB();
  closeFn = testDB.close;
  db = testDB.db;
  queue = new JobQueue(testDB.db);
  const workflowStore = new WorkflowStore({
    'test-simple': makeCompiled(simpleMachine, 'test-simple'),
    'test-loop': makeCompiled(loopMachine, 'test-loop'),
    'test-exhausted-gate': makeCompiled(exhaustedGateMachine, 'test-exhausted-gate'),
    'test-nested': makeCompiled(nestedLoopMachine, 'test-nested'),
    'test-nested-exit-failure': makeCompiled(nestedLoopExitMachine, 'test-nested-exit-failure'),
  });

  const interactionStore = new InteractionStore(testDB.db);
  deps = { db, queue, workflowStore, interactionStore };
});

afterEach(() => closeFn());

describe('initWorkflow', () => {
  test('sets workflow and currentStep', async () => {
    await createTask(db, undefined, { id: 'init-1', title: 'Init test' });
    const { workflow, startStep } = await initWorkflow('init-1', 'test-simple', deps);

    expect(workflow.name).toBe('test-simple');
    expect(startStep.type).toBe('context');

    const updated = await getTask(db, 'init-1');
    expect(updated.workflow).toBe('test-simple');
    expect(updated.currentStep).toBe('step_a');
  });

  test('persists workflowSnapshot on init', async () => {
    await createTask(db, undefined, { id: 'init-snap', title: 'Snapshot test' });
    await initWorkflow('init-snap', 'test-simple', deps);

    const updated = await getTask(db, 'init-snap');
    expect(updated.workflowSnapshot).not.toBeNull();
    const snap = JSON.parse(updated.workflowSnapshot!);
    expect(snap).toBeDefined();
  });

  test('defaults to standard workflow when name is undefined', async () => {
    await createTask(db, undefined, { id: 'init-2', title: 'Default test' });
    const { workflow } = await initWorkflow('init-2', undefined, deps);
    expect(workflow.name).toBe('standard');
  });
});

describe('completeStep', () => {
  test('transitions to next step and enqueues job', async () => {
    await createTask(db, undefined, { id: 'cs-1', title: 'Complete test' });
    await initWorkflow('cs-1', 'test-simple', deps);

    const result = await completeStep('cs-1', 'success', deps);
    expect(result.gated).toBe(true); // step_b is a gate

    const updated = await getTask(db, 'cs-1');
    expect(updated.currentStep).toBe('step_b');

    const jobs = await deps.queue.list({ taskId: 'cs-1' });
    expect(jobs).toHaveLength(0);
  });

  test('persists snapshot after transition', async () => {
    await createTask(db, undefined, { id: 'cs-snap', title: 'Snapshot after transition' });
    await initWorkflow('cs-snap', 'test-simple', deps);
    await completeStep('cs-snap', 'success', deps);

    const updated = await getTask(db, 'cs-snap');
    expect(updated.workflowSnapshot).not.toBeNull();
  });

  test('transitions to finish sets currentStep to null', async () => {
    await createTask(db, undefined, { id: 'cs-2', title: 'Finish test' });
    await initWorkflow('cs-2', 'test-simple', deps);

    // Complete step_a → step_b (gate)
    await completeStep('cs-2', 'success', deps);

    // Complete step_b → finish
    const result = await completeStep('cs-2', 'approved', deps);
    expect(result.finished).toBe(true);

    const updated = await getTask(db, 'cs-2');
    expect(updated.currentStep).toBeNull();
  });

  test('max iterations forces gate (actor context-based)', async () => {
    await createTask(db, undefined, { id: 'cs-3', title: 'Max iter test' });
    await initWorkflow('cs-3', 'test-simple', deps);
    // step_a maxIterations=3: init enters (count=1), 3 fail transitions re-enter (2,3,4→gate)
    await completeStep('cs-3', 'fail', deps); // count=2
    await completeStep('cs-3', 'fail', deps); // count=3
    const result = await completeStep('cs-3', 'fail', deps); // count=4 > 3 → gate

    expect(result.maxIterationsReached).toBe(true);
    expect(result.gated).toBe(true);

    const updated = await getTask(db, 'cs-3');
    expect(updated.status).toBe('stopped');
    const question = await questionStoreFns.getPendingForTask(db, 'cs-3');
    expect(question?.question).toContain('max iterations');
  });

  test('unknown outcome throws', async () => {
    await createTask(db, undefined, { id: 'cs-4', title: 'Unknown outcome' });
    await initWorkflow('cs-4', 'test-simple', deps);

    await expect(
      completeStep('cs-4', 'bogus', deps),
    ).rejects.toThrow();
  });

  test('carries output as feedback when includeOutput is true', async () => {
    await createTask(db, undefined, { id: 'cs-5', title: 'Payload test' });
    await initWorkflow('cs-5', 'test-simple', deps);
    await completeStep('cs-5', 'success', deps);

    // step_b rejected with output → step_a should get feedback
    await completeStep('cs-5', 'rejected', deps, {
      output: 'needs fixes',
    });

    const jobs = await deps.queue.list({ taskId: 'cs-5' });
    const lastJob = jobs[jobs.length - 1];
    expect(lastJob?.type as string).toBe('step_a');
    expect(lastJob?.payload).toEqual({ feedback: 'needs fixes' });
  });
});

describe('resumeUnblockedTask', () => {
  test('enqueues evaluate for task with no workflow state', async () => {
    await createTask(db, undefined, { id: 'ru-1', title: 'Unblocked test' });
    const task = await getTask(db, 'ru-1');

    await resumeUnblockedTask(task, deps);

    const updated = await getTask(db, 'ru-1');
    expect(updated.workflow).toBeNull();

    const jobs = await deps.queue.list({ taskId: 'ru-1' });
    expect(jobs.some((j) => j.type === 'evaluate')).toBe(true);
  });

  test('enqueues current step for task with existing workflow state', async () => {
    await createTask(db, undefined, { id: 'ru-2', title: 'Resume unblocked' });
    await initWorkflow('ru-2', 'test-simple', deps);
    await completeStep('ru-2', 'success', deps); // now at step_b

    const refreshed = await getTask(db, 'ru-2');
    await resumeUnblockedTask(refreshed, deps);

    const jobs = await deps.queue.list({ taskId: 'ru-2' });
    expect(jobs.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

describe('parsePath / joinPath', () => {
  test('splits dotted path', () => {
    expect(parsePath('implement.code')).toEqual(['implement', 'code']);
  });

  test('single segment', () => {
    expect(parsePath('plan')).toEqual(['plan']);
  });

  test('joins segments', () => {
    expect(joinPath(['implement', 'code'])).toBe('implement.code');
  });
});

describe('resolveStepMeta', () => {
  test('resolves flat step', () => {
    const { meta } = resolveStepMeta(loopMachine, 'plan');
    expect(meta.type).toBe('context');
  });

  test('resolves nested step in compound state', () => {
    const { meta, compoundPath } = resolveStepMeta(loopMachine, 'implement.code');
    expect(meta.type).toBe('code');
    expect(compoundPath).toEqual(['implement']);
  });

  test('throws for missing step', () => {
    expect(() => resolveStepMeta(loopMachine, 'nonexistent')).toThrow('not found');
  });
});

// ---------------------------------------------------------------------------
// Loop step transitions
// ---------------------------------------------------------------------------

describe('loop workflow', () => {
  test('loop entry: init sets currentStep to "plan"', async () => {
    await createTask(db, undefined, { id: 'lw-1', title: 'Loop entry' });
    await initWorkflow('lw-1', 'test-loop', deps);

    const updated = await getTask(db, 'lw-1');
    expect(updated.currentStep).toBe('plan');
  });

  test('entering loop auto-enters to loop.entry', async () => {
    await createTask(db, undefined, { id: 'lw-2', title: 'Loop auto-enter' });
    await initWorkflow('lw-2', 'test-loop', deps);

    // plan → done → implement → auto-enters implement.code
    const r = await completeStep('lw-2', 'done', deps);
    expect(r.enqueued?.type).toBe('implement.code');

    const t = await getTask(db, 'lw-2');
    expect(t.currentStep).toBe('implement.code');
  });

  test('inner next: implement.code → implement.review via next', async () => {
    await createTask(db, undefined, { id: 'lw-3', title: 'Inner next' });
    await initWorkflow('lw-3', 'test-loop', deps);
    await completeStep('lw-3', 'done', deps); // → implement.code

    const r = await completeStep('lw-3', 'success', deps);
    expect(r.enqueued?.type).toBe('implement.review');

    const t = await getTask(db, 'lw-3');
    expect(t.currentStep).toBe('implement.review');
  });

  test('exit: implement.review approved → exits loop → merge', async () => {
    await createTask(db, undefined, { id: 'lw-4', title: 'Exit loop' });
    await initWorkflow('lw-4', 'test-loop', deps);
    await completeStep('lw-4', 'done', deps); // → implement.code
    await completeStep('lw-4', 'success', deps); // → implement.review

    const r = await completeStep('lw-4', 'approved', deps);
    expect(r.enqueued?.type).toBe('merge');

    const t = await getTask(db, 'lw-4');
    expect(t.currentStep).toBe('merge');
  });

  test('review rejection loops back within loop', async () => {
    await createTask(db, undefined, { id: 'lw-5', title: 'Inner loop' });
    await initWorkflow('lw-5', 'test-loop', deps);
    await completeStep('lw-5', 'done', deps); // → implement.code
    await completeStep('lw-5', 'success', deps); // → implement.review

    // request_changes → back to implement.code
    const r = await completeStep('lw-5', 'request_changes', deps, {
      output: 'needs another pass',
    });
    expect(r.enqueued?.type).toBe('implement.code');

    const t = await getTask(db, 'lw-5');
    expect(t.currentStep).toBe('implement.code');

    const jobs = await deps.queue.list({ taskId: 'lw-5' });
    const lastJob = jobs[jobs.length - 1];
    expect(lastJob?.payload).toEqual({ feedback: 'needs another pass' });
  });

  test('inner maxIterations tracked via actor context', async () => {
    await createTask(db, undefined, { id: 'lw-6', title: 'Inner max iter' });
    await initWorkflow('lw-6', 'test-loop', deps);
    await completeStep('lw-6', 'done', deps); // → implement.code (count=1)
    // implement.code maxIterations=3: fail 3 times → count=2,3,4 → gate on 4th entry
    await completeStep('lw-6', 'fail', deps); // count=2
    await completeStep('lw-6', 'fail', deps); // count=3
    const r = await completeStep('lw-6', 'fail', deps); // count=4 > 3 → gate

    expect(r.maxIterationsReached).toBe(true);
    expect(r.gated).toBe(true);

    const t = await getTask(db, 'lw-6');
    expect(t.status).toBe('stopped');
    const question = await questionStoreFns.getPendingForTask(db, 'lw-6');
    expect(question?.question).toContain('max iterations');
  });

  test('full loop lifecycle: plan → implement(code→review→exit) → merge → finish', async () => {
    await createTask(db, undefined, { id: 'lw-7', title: 'Full loop' });
    await initWorkflow('lw-7', 'test-loop', deps);

    await completeStep('lw-7', 'done', deps); // plan → implement.code
    await completeStep('lw-7', 'success', deps); // implement.code → implement.review
    await completeStep('lw-7', 'approved', deps); // implement.review → exit → merge
    const r = await completeStep('lw-7', 'success', deps); // merge → finish
    expect(r.finished).toBe(true);
  });

  test('loop maxIterations gate stops task when exhausted', async () => {
    await createTask(db, undefined, { id: 'lw-8', title: 'Loop max iter' });
    await initWorkflow('lw-8', 'test-exhausted-gate', deps);

    const t0 = await getTask(db, 'lw-8');
    expect(t0.currentStep).toBe('loop.step');

    // loop maxIterations=2: init enters (count=1), retry twice (2,3 → gate on 3rd entry)
    await completeStep('lw-8', 'retry', deps); // count=2
    const result = await completeStep('lw-8', 'retry', deps); // count=3 > 2 → gate

    expect(result.maxIterationsReached).toBe(true);
    expect(result.gated).toBe(true);
  });
});

describe('nested loop workflow', () => {
  test('enters nested loop correctly', async () => {
    await createTask(db, undefined, { id: 'nl-1', title: 'Nested entry' });
    await initWorkflow('nl-1', 'test-nested', deps);

    // Should auto-enter: outer → outer.inner → outer.inner.code
    const t = await getTask(db, 'nl-1');
    expect(t.currentStep).toBe('outer.inner.code');
  });

  test('nested exit bubbles to outer scope', async () => {
    await createTask(db, undefined, { id: 'nl-2', title: 'Nested exit' });
    await initWorkflow('nl-2', 'test-nested', deps);

    // outer.inner.code → done → outer.check
    const r = await completeStep('nl-2', 'done', deps);
    expect(r.enqueued?.type).toBe('outer.check');

    const t = await getTask(db, 'nl-2');
    expect(t.currentStep).toBe('outer.check');
  });

  test('outer exit finishes workflow', async () => {
    await createTask(db, undefined, { id: 'nl-3', title: 'Nested full' });
    await initWorkflow('nl-3', 'test-nested', deps);

    await completeStep('nl-3', 'done', deps);
    const r = await completeStep('nl-3', 'pass', deps);
    expect(r.finished).toBe(true);
  });

  test('outer check retry re-enters inner loop', async () => {
    await createTask(db, undefined, { id: 'nl-4', title: 'Nested retry' });
    await initWorkflow('nl-4', 'test-nested', deps);

    await completeStep('nl-4', 'done', deps);
    // outer.check → retry → outer.inner → auto-enters outer.inner.code
    const r = await completeStep('nl-4', 'retry', deps);
    expect(r.enqueued?.type).toBe('outer.inner.code');

    const t = await getTask(db, 'nl-4');
    expect(t.currentStep).toBe('outer.inner.code');
  });

  test('nested loop exit directly to finish works', async () => {
    await createTask(db, undefined, {
      id: 'nl-5',
      title: 'Nested loop exit finish',
    });
    await initWorkflow('nl-5', 'test-nested-exit-failure', deps);

    const result = await completeStep('nl-5', 'done', deps);
    expect(result.finished).toBe(true);

    const task = await getTask(db, 'nl-5');
    expect(task.currentStep).toBeNull();
  });
});
