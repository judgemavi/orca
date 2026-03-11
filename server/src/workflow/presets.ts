import { assign, setup } from 'xstate';
import { buildTransitionMeta } from './paths';
import type {
  CompiledWorkflow,
  StepMeta,
  TransitionMeta,
  WorkflowContext,
  WorkflowMeta,
} from './types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createWorkflowMachine(id: string, config: Record<string, any>) {
  return setup({
    types: {
      context: {} as WorkflowContext,
      events: {} as { type: string },
    },
    actions: {
      incrementIteration: assign({
        iterations: (
          { context }: { context: WorkflowContext },
          params: { stepPath: string },
        ) => ({
          ...context.iterations,
          [params.stepPath]: (context.iterations[params.stepPath] ?? 0) + 1,
        }),
      }),
    },
    guards: {
      withinIterationLimit: (
        { context }: { context: WorkflowContext },
        params: { stepPath: string; max: number },
      ) => (context.iterations[params.stepPath] ?? 0) < params.max,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any).createMachine({
    id,
    context: { iterations: {} },
    ...config,
  });
}

const standardMachine = createWorkflowMachine('standard', {
  initial: 'plan',
  meta: { dependencyGate: 'plan' } as WorkflowMeta,
  states: {
    plan: {
      meta: {
        type: 'context',
        executor: 'tool',
        prompt: 'plan',
        consumes: [],
        autoRun: true,
        priority: 4,
      } as StepMeta,
      entry: { type: 'incrementIteration', params: { stepPath: 'plan' } },
      on: { done: 'implement' },
    },
    implement: {
      meta: { maxIterations: 3 } as StepMeta,
      initial: 'code',
      states: {
        code: {
          meta: {
            type: 'code',
            executor: 'tool',
            prompt: 'code',
            consumes: ['plan'],
            autoRun: true,
            maxIterations: 3,
            priority: 0,
          } as StepMeta,
          entry: {
            type: 'incrementIteration',
            params: { stepPath: 'implement.code' },
          },
          on: {
            success: 'review',
            fail: {
              target: 'code',
              reenter: true,
              guard: {
                type: 'withinIterationLimit',
                params: { stepPath: 'implement.code', max: 3 },
              },
              meta: { includeOutput: true } as TransitionMeta,
            },
          },
        },
        review: {
          meta: {
            type: 'decision',
            executor: 'tool',
            prompt: 'review',
            consumes: ['plan', 'code'],
            autoRun: true,
            maxIterations: 3,
            priority: 1,
          } as StepMeta,
          entry: {
            type: 'incrementIteration',
            params: { stepPath: 'implement.review' },
          },
          on: {
            approved: {
              target: '#standard.merge',
              meta: { includeOutput: false } as TransitionMeta,
            },
            request_changes: {
              target: 'code',
              guard: {
                type: 'withinIterationLimit',
                params: { stepPath: 'implement.code', max: 3 },
              },
              meta: { includeOutput: true } as TransitionMeta,
            },
          },
        },
      },
    },
    merge: {
      meta: { type: 'merge', autoRun: true, priority: 2 } as StepMeta,
      entry: { type: 'incrementIteration', params: { stepPath: 'merge' } },
      on: { success: 'finish' },
    },
    finish: { type: 'final' as const },
  },
});

const directMachine = createWorkflowMachine('direct', {
  initial: 'code',
  meta: { dependencyGate: 'code' } as WorkflowMeta,
  states: {
    code: {
      meta: {
        type: 'code',
        executor: 'tool',
        prompt: 'code',
        consumes: [],
        autoRun: true,
        maxIterations: 3,
        priority: 0,
      } as StepMeta,
      entry: { type: 'incrementIteration', params: { stepPath: 'code' } },
      on: {
        success: 'review',
        fail: {
          target: 'code',
          reenter: true,
          guard: {
            type: 'withinIterationLimit',
            params: { stepPath: 'code', max: 3 },
          },
          meta: { includeOutput: true } as TransitionMeta,
        },
      },
    },
    review: {
      meta: {
        type: 'decision',
        executor: 'tool',
        prompt: 'review',
        consumes: ['code'],
        autoRun: true,
        maxIterations: 3,
        priority: 1,
      } as StepMeta,
      entry: { type: 'incrementIteration', params: { stepPath: 'review' } },
      on: {
        approved: 'merge',
        rejected: {
          target: 'code',
          guard: {
            type: 'withinIterationLimit',
            params: { stepPath: 'code', max: 3 },
          },
          meta: { includeOutput: true } as TransitionMeta,
        },
      },
    },
    merge: {
      meta: { type: 'merge', autoRun: true, priority: 2 } as StepMeta,
      entry: { type: 'incrementIteration', params: { stepPath: 'merge' } },
      on: { success: 'finish' },
    },
    finish: { type: 'final' as const },
  },
});

export const builtinWorkflows: Record<string, CompiledWorkflow> = {
  standard: {
    machine: standardMachine,
    name: 'standard',
    transitionMeta: buildTransitionMeta(standardMachine),
  },
  direct: {
    machine: directMachine,
    name: 'direct',
    transitionMeta: buildTransitionMeta(directMachine),
  },
};
