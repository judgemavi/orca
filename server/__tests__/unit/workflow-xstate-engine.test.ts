import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { AnyStateMachine } from 'xstate';
import type { OrcaDrizzleDB } from '../../src/db/connection';
import { JobQueue } from '../../src/queue/queue';
import { createTask, getTask } from '../../src/store/tasks';
import {
  completeStep,
  initWorkflow,
} from '../../src/workflow/engine';
import type { WorkflowEngineDeps } from '../../src/workflow/engine';
import { WorkflowStore } from '../../src/workflow/store';
import type { CompiledWorkflow, StepMeta, TransitionMeta } from '../../src/workflow/types';
import { buildTransitionMeta } from '../../src/workflow/paths';
import { createWorkflowMachine } from '../../src/workflow/presets';
import { createTestDB } from '../helpers/db';

let closeFn: () => void;
let deps: WorkflowEngineDeps;
let db: OrcaDrizzleDB;

function makeCompiled(machine: AnyStateMachine, name: string): CompiledWorkflow {
  return { machine, name, transitionMeta: buildTransitionMeta(machine) };
}

const simpleMachine = createWorkflowMachine('xstate-simple', {
  initial: 'step_a',
  states: {
    step_a: {
      meta: { type: 'context', executor: 'tool', prompt: 'a' } as StepMeta,
      entry: { type: 'incrementIteration', params: { stepPath: 'step_a' } },
      on: { success: 'step_b' },
    },
    step_b: {
      meta: { type: 'gate', executor: 'none' } as StepMeta,
      on: {
        rejected: { target: 'step_a', meta: { includeOutput: true } as TransitionMeta },
        approved: 'finish',
      },
    },
    finish: { type: 'final' as const },
  },
});

const nestedExitMachine = createWorkflowMachine('xstate-nested-exit', {
  initial: 'outer',
  states: {
    outer: {
      initial: 'inner',
      states: {
        inner: {
          initial: 'code',
          states: {
            code: {
              meta: { type: 'code', executor: 'tool', prompt: 'code' } as StepMeta,
              entry: { type: 'incrementIteration', params: { stepPath: 'outer.inner.code' } },
              on: { done: '#xstate-nested-exit.finish' },
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

  deps = {
    db,
    queue: new JobQueue(testDB.db),
    workflowStore: new WorkflowStore({
      'xstate-simple': makeCompiled(simpleMachine, 'xstate-simple'),
      'xstate-nested-exit': makeCompiled(nestedExitMachine, 'xstate-nested-exit'),
    }),
  };
});

afterEach(() => closeFn());

describe('actor workflow engine', () => {
  test('respects gate semantics without enqueueing the gate step', async () => {
    await createTask(db, undefined, { id: 'xse-1', title: 'Gate test' });
    await initWorkflow('xse-1', 'xstate-simple', deps);

    const result = await completeStep('xse-1', 'success', deps);
    expect(result.gated).toBe(true);

    const updated = await getTask(db, 'xse-1');
    expect(updated.currentStep).toBe('step_b');

    const jobs = await deps.queue.list({ taskId: 'xse-1' });
    expect(jobs).toHaveLength(0);
  });

  test('forwards includeOutput payload metadata', async () => {
    await createTask(db, undefined, { id: 'xse-2', title: 'Payload test' });
    await initWorkflow('xse-2', 'xstate-simple', deps);
    await completeStep('xse-2', 'success', deps);

    await completeStep('xse-2', 'rejected', deps, {
      output: 'needs work',
    });

    const jobs = await deps.queue.list({ taskId: 'xse-2' });
    const lastJob = jobs[jobs.length - 1];
    expect(lastJob?.type as string | undefined).toBe('step_a');
    expect(lastJob?.payload).toEqual({ feedback: 'needs work' });
  });

  test('supports nested loop exit directly to finish', async () => {
    await createTask(db, undefined, {
      id: 'xse-3',
      title: 'Nested exit bubble',
    });
    await initWorkflow('xse-3', 'xstate-nested-exit', deps);

    const result = await completeStep('xse-3', 'done', deps);
    expect(result.finished).toBe(true);

    const task = await getTask(db, 'xse-3');
    expect(task.currentStep).toBeNull();
  });

  test('persists workflow snapshot on each step', async () => {
    await createTask(db, undefined, { id: 'xse-4', title: 'Snapshot persist' });
    await initWorkflow('xse-4', 'xstate-simple', deps);

    const t1 = await getTask(db, 'xse-4');
    expect(t1.workflowSnapshot).not.toBeNull();

    await completeStep('xse-4', 'success', deps);

    const t2 = await getTask(db, 'xse-4');
    expect(t2.workflowSnapshot).not.toBeNull();
  });
});
