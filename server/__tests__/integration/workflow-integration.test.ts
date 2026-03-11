import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { AnyStateMachine } from 'xstate';
import type { OrcaDrizzleDB } from '../../src/db/connection';
import { JobQueue } from '../../src/queue/queue';
import { patchConfig } from '../../src/store/config';
import * as questionStoreFns from '../../src/store/questions';
import { createTask, getTask, updateTask } from '../../src/store/tasks';
import {
  completeStep,
  initWorkflow,
  resumeUnblockedTask,
} from '../../src/workflow/engine';
import type { WorkflowEngineDeps } from '../../src/workflow/engine';
import { WorkflowStore } from '../../src/workflow/store';
import type { CompiledWorkflow, StepMeta, TransitionMeta } from '../../src/workflow/types';
import { buildTransitionMeta } from '../../src/workflow/paths';
import { createWorkflowMachine } from '../../src/workflow/presets';
import { createTestDB } from '../helpers/db';
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

const customMachine = createWorkflowMachine('custom-test', {
  initial: 'analyze',
  states: {
    analyze: {
      meta: { type: 'context', executor: 'tool', prompt: 'analyze', autoRun: true } as StepMeta,
      entry: { type: 'incrementIteration', params: { stepPath: 'analyze' } },
      on: { done: 'implement', skip: 'finish' },
    },
    implement: {
      meta: { type: 'code', executor: 'tool', prompt: 'implement', autoRun: true, maxIterations: 2 } as StepMeta,
      entry: { type: 'incrementIteration', params: { stepPath: 'implement' } },
      on: {
        success: 'verify',
        fail: { target: 'implement', reenter: true, meta: { includeOutput: true } as TransitionMeta },
      },
    },
    verify: {
      meta: { type: 'command', executor: 'shell', command: 'verify', autoRun: true } as StepMeta,
      entry: { type: 'incrementIteration', params: { stepPath: 'verify' } },
      on: { pass: 'finish', fail: 'implement' },
    },
    finish: { type: 'final' as const },
  },
});

const loopMachine = createWorkflowMachine('loop-test', {
  initial: 'plan',
  states: {
    plan: {
      meta: { type: 'context', executor: 'tool', prompt: 'plan', autoRun: true } as StepMeta,
      entry: { type: 'incrementIteration', params: { stepPath: 'plan' } },
      on: { done: 'implement' },
    },
    implement: {
      meta: { maxIterations: 5 } as StepMeta,
      initial: 'code',
      states: {
        code: {
          meta: { type: 'code', executor: 'tool', prompt: 'code', autoRun: true, consumes: ['plan'], maxIterations: 3 } as StepMeta,
          entry: { type: 'incrementIteration', params: { stepPath: 'implement.code' } },
          on: {
            success: 'review',
            fail: { target: 'code', reenter: true, meta: { includeOutput: true } as TransitionMeta },
          },
        },
        review: {
          meta: { type: 'decision', executor: 'tool', prompt: 'review', autoRun: true, consumes: ['code'] } as StepMeta,
          entry: { type: 'incrementIteration', params: { stepPath: 'implement.review' } },
          on: {
            approved: '#loop-test.merge',
            request_changes: { target: 'code', meta: { includeOutput: true } as TransitionMeta },
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

const manualImplMachine = createWorkflowMachine('manual-impl', {
  initial: 'analyze',
  states: {
    analyze: {
      meta: { type: 'context', executor: 'tool', prompt: 'analyze', autoRun: true } as StepMeta,
      entry: { type: 'incrementIteration', params: { stepPath: 'analyze' } },
      on: { done: 'implement' },
    },
    implement: {
      meta: { type: 'code', executor: 'tool', prompt: 'implement', autoRun: false } as StepMeta,
      entry: { type: 'incrementIteration', params: { stepPath: 'implement' } },
      on: { success: 'finish' },
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
    'custom-test': makeCompiled(customMachine, 'custom-test'),
    'manual-impl': makeCompiled(manualImplMachine, 'manual-impl'),
    'loop-test': makeCompiled(loopMachine, 'loop-test'),
  });
  const interactionStore = new InteractionStore(testDB.db);
  deps = { db, queue, workflowStore, interactionStore };
});

afterEach(() => closeFn());

describe('workflow init on task creation', () => {
  test('initWorkflow sets workflow state and returns start step', async () => {
    await createTask(db, undefined, { id: 'wi-1', title: 'Init test' });
    const { workflow, startStep } = await initWorkflow('wi-1', 'custom-test', deps);

    expect(workflow.name).toBe('custom-test');
    expect(startStep.type).toBe('context');

    const updated = await getTask(db, 'wi-1');
    expect(updated.workflow).toBe('custom-test');
    expect(updated.currentStep).toBe('analyze');
    expect(updated.workflowSnapshot).not.toBeNull();
  });

  test('custom workflow start step differs from standard', async () => {
    await createTask(db, undefined, { id: 'wi-2', title: 'Custom start' });
    await initWorkflow('wi-2', 'custom-test', deps);

    const updated = await getTask(db, 'wi-2');
    expect(updated.currentStep).toBe('analyze');

    await createTask(db, undefined, { id: 'wi-3', title: 'Standard start' });
    await initWorkflow('wi-3', undefined, deps);

    const updated2 = await getTask(db, 'wi-3');
    expect(updated2.currentStep).toBe('plan');
  });

  test('direct workflow starts at code', async () => {
    await createTask(db, undefined, { id: 'wi-4', title: 'Direct start' });
    await initWorkflow('wi-4', 'direct', deps);

    const updated = await getTask(db, 'wi-4');
    expect(updated.currentStep).toBe('code');
  });
});

describe('step completion routing', () => {
  test('routes through custom workflow branches', async () => {
    await createTask(db, undefined, { id: 'scr-1', title: 'Route test' });
    await initWorkflow('scr-1', 'custom-test', deps);

    // analyze → done → implement
    const r1 = await completeStep('scr-1', 'done', deps);
    expect(r1.enqueued?.type).toBe('implement');

    const t1 = await getTask(db, 'scr-1');
    expect(t1.currentStep).toBe('implement');

    // implement → success → verify
    const r2 = await completeStep('scr-1', 'success', deps);
    expect(r2.enqueued?.type).toBe('verify');

    const t2 = await getTask(db, 'scr-1');
    expect(t2.currentStep).toBe('verify');

    // verify → pass → finish
    const r3 = await completeStep('scr-1', 'pass', deps);
    expect(r3.finished).toBe(true);
  });

  test('skip outcome goes directly to finish', async () => {
    await createTask(db, undefined, { id: 'scr-2', title: 'Skip test' });
    await initWorkflow('scr-2', 'custom-test', deps);

    const result = await completeStep('scr-2', 'skip', deps);
    expect(result.finished).toBe(true);
  });

  test('fail loops back with output as feedback', async () => {
    await createTask(db, undefined, { id: 'scr-3', title: 'Fail loop' });
    await initWorkflow('scr-3', 'custom-test', deps);
    await completeStep('scr-3', 'done', deps); // → implement

    const result = await completeStep('scr-3', 'fail', deps, {
      output: 'something went wrong',
    });
    expect(result.enqueued?.type).toBe('implement');

    const jobs = await queue.list({ taskId: 'scr-3' });
    const lastJob = jobs[jobs.length - 1];
    expect(lastJob?.payload).toEqual({ feedback: 'something went wrong' });
  });

  test('max iterations forces gate on step (actor context-based)', async () => {
    await createTask(db, undefined, { id: 'scr-4', title: 'Max iter' });
    await initWorkflow('scr-4', 'custom-test', deps);
    await completeStep('scr-4', 'done', deps); // → implement (count=1)
    // implement maxIterations=2: fail once (count=2), fail again (count=3 > 2 → gate)
    await completeStep('scr-4', 'fail', deps); // count=2
    const result = await completeStep('scr-4', 'fail', deps); // count=3 > 2 → gate

    expect(result.maxIterationsReached).toBe(true);
    expect(result.gated).toBe(true);

    const updated = await getTask(db, 'scr-4');
    expect(updated.status).toBe('stopped');
    const pendingQ = await questionStoreFns.getPendingForTask(db, 'scr-4');
    expect(pendingQ?.question).toContain('max iterations');
  });

  test('verify fail routes back to implement', async () => {
    await createTask(db, undefined, { id: 'scr-5', title: 'Verify fail' });
    await initWorkflow('scr-5', 'custom-test', deps);
    await completeStep('scr-5', 'done', deps); // → implement
    await completeStep('scr-5', 'success', deps); // → verify

    const result = await completeStep('scr-5', 'fail', deps);
    expect(result.enqueued?.type).toBe('implement');

    const t = await getTask(db, 'scr-5');
    expect(t.currentStep).toBe('implement');
  });
});

describe('autoRun gating', () => {
  test('step autoRun=false gates the step', async () => {
    await createTask(db, undefined, { id: 'ar-1', title: 'Step autoRun false' });
    await initWorkflow('ar-1', 'manual-impl', deps);

    // analyze → done → implement, but implement has autoRun=false
    const result = await completeStep('ar-1', 'done', deps);
    expect(result.gated).toBe(true);

    const jobs = await queue.list({ taskId: 'ar-1' });
    const implementJobs = jobs.filter((j) => (j.type as string) === 'implement');
    expect(implementJobs.length).toBe(0);
  });

  test('global autoRun=false gates everything', async () => {
    await patchConfig(db, undefined, { autoRun: false });

    await createTask(db, undefined, { id: 'ar-2', title: 'Global autoRun false' });
    await initWorkflow('ar-2', 'custom-test', deps);

    const result = await completeStep('ar-2', 'done', deps);
    expect(result.gated).toBe(true);

    const jobs = await queue.list({ taskId: 'ar-2' });
    const implementJobs = jobs.filter((j) => (j.type as string) === 'implement');
    expect(implementJobs.length).toBe(0);
  });

  test('task autoRunOverrides override step def', async () => {
    await createTask(db, undefined, { id: 'ar-3', title: 'Task override' });
    await updateTask(db, undefined, 'ar-3', {
      autoRunOverrides: { implement: true },
    });
    await initWorkflow('ar-3', 'manual-impl', deps);

    const result = await completeStep('ar-3', 'done', deps);
    expect(result.enqueued?.type).toBe('implement');
  });

  test('global autoRun=false cannot be overridden by task override', async () => {
    await patchConfig(db, undefined, { autoRun: false });

    await createTask(db, undefined, { id: 'ar-4', title: 'Global beats task' });
    await updateTask(db, undefined, 'ar-4', {
      autoRunOverrides: { implement: true },
    });
    await initWorkflow('ar-4', 'custom-test', deps);

    const result = await completeStep('ar-4', 'done', deps);
    expect(result.gated).toBe(true);
  });
});

describe('dependency unblocking', () => {
  test('resumeUnblockedTask enqueues evaluate for task without state', async () => {
    await createTask(db, undefined, { id: 'du-1', title: 'Unblocked no state' });
    const task = await getTask(db, 'du-1');

    await resumeUnblockedTask(task, deps);

    const updated = await getTask(db, 'du-1');
    expect(updated.workflow).toBeNull();

    const jobs = await queue.list({ taskId: 'du-1' });
    expect(jobs.some((j) => j.type === 'evaluate')).toBe(true);
  });

  test('resumeUnblockedTask resumes at currentStep', async () => {
    await createTask(db, undefined, { id: 'du-2', title: 'Unblocked w/ state' });
    await initWorkflow('du-2', 'custom-test', deps);
    await completeStep('du-2', 'done', deps); // → implement

    const jobs = await queue.list({ taskId: 'du-2' });
    for (const j of jobs) await queue.complete(j.id, {});

    const refreshed = await getTask(db, 'du-2');
    await resumeUnblockedTask(refreshed, deps);

    const newJobs = await queue.list({ taskId: 'du-2' });
    const pending = newJobs.filter((j) => j.status === 'queued');
    expect(pending.some((j) => (j.type as string) === 'implement')).toBe(true);
  });

  test('resumeUnblockedTask always enqueues evaluate (system-controlled)', async () => {
    await patchConfig(db, undefined, { autoRun: false });

    await createTask(db, undefined, { id: 'du-3', title: 'Unblocked no auto' });
    const task = await getTask(db, 'du-3');
    await resumeUnblockedTask(task, deps);

    const jobs = await queue.list({ taskId: 'du-3' });
    expect(jobs.some((j) => j.type === 'evaluate')).toBe(true);
  });
});

describe('standard workflow lifecycle', () => {
  test('plan → implement.code → implement.review → merge → finish', async () => {
    await createTask(db, undefined, { id: 'sw-1', title: 'Full lifecycle' });
    await initWorkflow('sw-1', 'standard', deps);

    let r = await completeStep('sw-1', 'done', deps);
    expect(r.enqueued?.type).toBe('implement.code');

    r = await completeStep('sw-1', 'success', deps);
    expect(r.enqueued?.type).toBe('implement.review');

    r = await completeStep('sw-1', 'approved', deps);
    expect(r.enqueued?.type).toBe('merge');

    r = await completeStep('sw-1', 'success', deps);
    expect(r.finished).toBe(true);
  });

  test('review rejection loops back to code within loop', async () => {
    await createTask(db, undefined, { id: 'sw-2', title: 'Review reject' });
    await initWorkflow('sw-2', 'standard', deps);

    await completeStep('sw-2', 'done', deps);
    await completeStep('sw-2', 'success', deps);

    const r = await completeStep('sw-2', 'request_changes', deps);
    expect(r.enqueued?.type).toBe('implement.code');

    const t = await getTask(db, 'sw-2');
    expect(t.currentStep).toBe('implement.code');
  });
});

describe('edge cases', () => {
  test('completeStep on nonexistent task throws', async () => {
    await expect(
      completeStep('nonexistent-id', 'success', deps),
    ).rejects.toThrow('nonexistent-id not found');
  });

  test('completeStep on task with no currentStep throws', async () => {
    await createTask(db, undefined, { id: 'ec-1', title: 'No step' });
    await expect(
      completeStep('ec-1', 'success', deps),
    ).rejects.toThrow('no current step');
  });

  test('initWorkflow with unknown workflow throws', async () => {
    await createTask(db, undefined, { id: 'ec-2', title: 'Bad workflow' });
    await expect(
      initWorkflow('ec-2', 'nonexistent-workflow', deps),
    ).rejects.toThrow('not found');
  });

  test('iteration counts reflected in actor context', async () => {
    await createTask(db, undefined, { id: 'ec-3', title: 'Iter counts' });
    await initWorkflow('ec-3', 'standard', deps);

    await completeStep('ec-3', 'done', deps);
    await completeStep('ec-3', 'fail', deps); // implement.code count=2
    await completeStep('ec-3', 'fail', deps); // implement.code count=3

    const t = await getTask(db, 'ec-3');
    expect(t.currentStep).toBe('implement.code');
    const ctx = JSON.parse(t.workflowSnapshot!);
    // Snapshot has context with iterations
    expect(ctx).toBeDefined();
  });
});

describe('loop workflow lifecycle', () => {
  test('plan → implement(code→review→exit) → merge → finish', async () => {
    await createTask(db, undefined, { id: 'lwl-1', title: 'Loop lifecycle' });
    await initWorkflow('lwl-1', 'loop-test', deps);

    let r = await completeStep('lwl-1', 'done', deps);
    expect(r.enqueued?.type).toBe('implement.code');

    r = await completeStep('lwl-1', 'success', deps);
    expect(r.enqueued?.type).toBe('implement.review');

    r = await completeStep('lwl-1', 'approved', deps);
    expect(r.enqueued?.type).toBe('merge');

    r = await completeStep('lwl-1', 'success', deps);
    expect(r.finished).toBe(true);
  });

  test('review rejection loops back within loop', async () => {
    await createTask(db, undefined, { id: 'lwl-2', title: 'Loop reject' });
    await initWorkflow('lwl-2', 'loop-test', deps);

    await completeStep('lwl-2', 'done', deps);
    await completeStep('lwl-2', 'success', deps);

    const r = await completeStep('lwl-2', 'request_changes', deps);
    expect(r.enqueued?.type).toBe('implement.code');

    const t = await getTask(db, 'lwl-2');
    expect(t.currentStep).toBe('implement.code');

    await completeStep('lwl-2', 'success', deps);
    await completeStep('lwl-2', 'approved', deps);
    const r2 = await completeStep('lwl-2', 'success', deps);
    expect(r2.finished).toBe(true);
  });

  test('code→review feedback flows through includeOutput', async () => {
    await createTask(db, undefined, { id: 'lwl-3', title: 'Loop feedback' });
    await initWorkflow('lwl-3', 'loop-test', deps);

    await completeStep('lwl-3', 'done', deps);
    await completeStep('lwl-3', 'success', deps);

    await completeStep('lwl-3', 'request_changes', deps, {
      output: 'fix the tests',
    });

    const jobs = await queue.list({ taskId: 'lwl-3' });
    const codeJobs = jobs.filter((j) => (j.type as string) === 'implement.code');
    const lastCodeJob = codeJobs[codeJobs.length - 1];
    expect(lastCodeJob?.payload).toEqual({ feedback: 'fix the tests' });
  });

  test('inner code maxIterations stops at gate (actor context-based)', async () => {
    await createTask(db, undefined, { id: 'lwl-4', title: 'Inner max iter' });
    await initWorkflow('lwl-4', 'loop-test', deps);

    await completeStep('lwl-4', 'done', deps); // implement.code entered (count=1)
    // maxIterations=3: fail 3 times → count=2,3,4 → gate on 4th entry
    await completeStep('lwl-4', 'fail', deps); // count=2
    await completeStep('lwl-4', 'fail', deps); // count=3
    const r = await completeStep('lwl-4', 'fail', deps); // count=4 > 3 → gate

    expect(r.maxIterationsReached).toBe(true);
    expect(r.gated).toBe(true);

    const t = await getTask(db, 'lwl-4');
    expect(t.status).toBe('stopped');
    const question = await questionStoreFns.getPendingForTask(db, 'lwl-4');
    expect(question?.question).toContain('max iterations');
  });
});
