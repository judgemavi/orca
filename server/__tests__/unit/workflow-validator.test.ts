import { describe, expect, test } from 'bun:test';
import { ToolPluginRegistry } from '../../src/plugin/registry';
import type { Config } from '../../src/db/schema';
import { DEFAULT_CONFIG } from '../../src/db/schema';
import { validateWorkflow } from '../../src/workflow/validator';
import { builtinWorkflows } from '../../src/workflow/presets';
import type { StepMeta, TransitionMeta, WorkflowMeta } from '../../src/workflow/types';

const registry = new ToolPluginRegistry(true);
const config: Config = structuredClone(DEFAULT_CONFIG);

function validate(workflow: unknown) {
  return validateWorkflow(workflow, config, registry);
}

/** Helper to build a minimal machine config for tests */
function makeMachine(overrides: {
  id?: string;
  initial: string;
  meta?: WorkflowMeta;
  states: Record<string, unknown>;
}) {
  return {
    id: overrides.id ?? 'test',
    initial: overrides.initial,
    ...(overrides.meta ? { meta: overrides.meta } : {}),
    states: overrides.states,
  };
}

function gateState(on: Record<string, unknown>): Record<string, unknown> {
  return { meta: { type: 'gate', executor: 'none' } as StepMeta, on };
}

function contextState(
  on: Record<string, unknown>,
  extra?: Partial<StepMeta>,
): Record<string, unknown> {
  return {
    meta: { type: 'context', executor: 'tool', prompt: 'test', autoRun: true, ...extra } as StepMeta,
    on,
  };
}

function codeState(on: Record<string, unknown>, extra?: Partial<StepMeta>): Record<string, unknown> {
  return {
    meta: { type: 'code', executor: 'tool', prompt: 'code', autoRun: true, ...extra } as StepMeta,
    on,
  };
}

function commandMergeState(on: Record<string, unknown>): Record<string, unknown> {
  return {
    meta: { type: 'command', executor: 'shell', command: 'merge', autoRun: true } as StepMeta,
    on,
  };
}

function mergeState(): Record<string, unknown> {
  return {
    meta: { type: 'merge', autoRun: true } as StepMeta,
    on: { success: 'finish' },
  };
}

describe('schema validation', () => {
  test('rejects missing id', () => {
    const errors = validate({ initial: 'a', states: {} });
    expect(errors.some((e) => e.message.toLowerCase().includes('id'))).toBe(true);
  });

  test('rejects missing initial', () => {
    const errors = validate({ id: 'x', states: {} });
    expect(errors.some((e) => e.message.toLowerCase().includes('initial'))).toBe(true);
  });

  test('rejects invalid step type in meta', () => {
    const errors = validate(
      makeMachine({
        initial: 'a',
        states: {
          a: { meta: { type: 'bogus', executor: 'tool' }, on: { ok: 'finish' } },
          finish: { type: 'final' },
        },
      }),
    );
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('structural validation', () => {
  test('initial state must exist', () => {
    const errors = validate(
      makeMachine({
        initial: 'missing',
        states: {
          a: gateState({ ok: 'finish' }),
          finish: { type: 'final' },
        },
      }),
    );
    expect(errors.some((e) => e.message.includes('initial state "missing" not found'))).toBe(true);
  });

  test('must have at least one branch', () => {
    const errors = validate(
      makeMachine({
        initial: 'a',
        states: {
          a: { meta: { type: 'gate', executor: 'none' } as StepMeta, on: {} },
          finish: { type: 'final' },
        },
      }),
    );
    expect(errors.some((e) => e.message.includes('at least one'))).toBe(true);
  });
});

describe('executor/type constraints', () => {
  test('context step rejects shell executor', () => {
    const errors = validate(
      makeMachine({
        initial: 'a',
        states: {
          a: {
            meta: { type: 'context', executor: 'shell', prompt: 'x', autoRun: true } as StepMeta,
            on: { ok: 'finish' },
          },
          finish: { type: 'final' },
        },
      }),
    );
    expect(errors.some((e) => e.step === 'a' && e.message.includes('tool'))).toBe(true);
  });

  test('code step rejects shell executor', () => {
    const errors = validate(
      makeMachine({
        initial: 'a',
        states: {
          a: {
            meta: { type: 'code', executor: 'shell', prompt: 'x', autoRun: true } as StepMeta,
            on: { ok: 'finish' },
          },
          finish: { type: 'final' },
        },
      }),
    );
    expect(errors.some((e) => e.step === 'a' && e.message.includes('tool'))).toBe(true);
  });

  test('command step requires shell executor', () => {
    const errors = validate(
      makeMachine({
        initial: 'a',
        states: {
          a: {
            meta: { type: 'command', executor: 'tool', command: 'echo', autoRun: true } as StepMeta,
            on: { ok: 'finish' },
          },
          finish: { type: 'final' },
        },
      }),
    );
    expect(errors.some((e) => e.step === 'a' && e.message.includes('shell'))).toBe(true);
  });

  test('gate step requires none executor', () => {
    const errors = validate(
      makeMachine({
        initial: 'a',
        states: {
          a: {
            meta: { type: 'gate', executor: 'tool' } as StepMeta,
            on: { ok: 'finish' },
          },
          finish: { type: 'final' },
        },
      }),
    );
    expect(errors.some((e) => e.step === 'a' && e.message.includes('none'))).toBe(true);
  });

  test('tool executor requires prompt', () => {
    const errors = validate(
      makeMachine({
        initial: 'a',
        states: {
          a: {
            meta: { type: 'context', executor: 'tool', autoRun: true } as StepMeta,
            on: { ok: 'finish' },
          },
          finish: { type: 'final' },
        },
      }),
    );
    expect(errors.some((e) => e.message.includes('prompt required'))).toBe(true);
  });

  test('shell executor requires command', () => {
    const errors = validate(
      makeMachine({
        initial: 'a',
        states: {
          a: {
            meta: { type: 'command', executor: 'shell', autoRun: true } as StepMeta,
            on: { ok: 'finish' },
          },
          finish: { type: 'final' },
        },
      }),
    );
    expect(errors.some((e) => e.message.includes('command required'))).toBe(true);
  });
});

describe('reachability', () => {
  test('all steps must reach finish', () => {
    const errors = validate(
      makeMachine({
        initial: 'a',
        states: {
          a: gateState({ ok: 'finish' }),
          b: { meta: { type: 'gate', executor: 'none' } as StepMeta, on: { ok: 'b' }, ...{ maxIterations: 1 } },
          finish: { type: 'final' },
        },
      }),
    );
    expect(errors.some((e) => e.step === 'b' && e.message.includes('cannot reach "finish"'))).toBe(true);
  });

  test('valid workflow has all steps reaching finish', () => {
    const errors = validate(
      makeMachine({
        initial: 'a',
        states: {
          a: gateState({ ok: 'b' }),
          b: gateState({ ok: 'finish' }),
          finish: { type: 'final' },
        },
      }),
    );
    const reachErrors = errors.filter((e) => e.message.includes('cannot reach'));
    expect(reachErrors).toHaveLength(0);
  });
});

describe('cycle detection', () => {
  test('unguarded cycle is rejected', () => {
    const errors = validate(
      makeMachine({
        initial: 'a',
        states: {
          a: gateState({ loop: 'b', done: 'finish' }),
          b: gateState({ back: 'a' }),
          finish: { type: 'final' },
        },
      }),
    );
    expect(
      errors.some((e) => e.message.includes('cycle detected') && e.message.includes('without maxIterations')),
    ).toBe(true);
  });

  test('guarded cycle is accepted', () => {
    const errors = validate(
      makeMachine({
        initial: 'a',
        states: {
          a: {
            meta: { type: 'gate', executor: 'none', maxIterations: 3 } as StepMeta,
            on: { loop: 'b', done: 'finish' },
          },
          b: gateState({ back: 'a' }),
          finish: { type: 'final' },
        },
      }),
    );
    const cycleErrors = errors.filter((e) => e.message.includes('cycle detected'));
    expect(cycleErrors).toHaveLength(0);
  });
});

describe('code/merge constraint', () => {
  test('code step without merge step is rejected', () => {
    const errors = validate(
      makeMachine({
        initial: 'a',
        states: {
          a: codeState({ ok: 'finish' }),
          finish: { type: 'final' },
        },
      }),
    );
    expect(errors.some((e) => e.message.includes('no merge step'))).toBe(true);
  });

  test('code step after merge is rejected', () => {
    const errors = validate(
      makeMachine({
        initial: 'c',
        states: {
          c: codeState({ ok: 'm' }),
          m: commandMergeState({ ok: 'c2' }),
          c2: codeState({ ok: 'finish' }),
          finish: { type: 'final' },
        },
      }),
    );
    expect(errors.some((e) => e.step === 'c2' && e.message.includes('after merge'))).toBe(true);
  });

  test('code before merge is accepted', () => {
    const errors = validate(
      makeMachine({
        initial: 'c',
        states: {
          c: codeState({ ok: 'm' }),
          m: commandMergeState({ ok: 'finish' }),
          finish: { type: 'final' },
        },
      }),
    );
    const mergeErrors = errors.filter((e) => e.message.includes('merge'));
    expect(mergeErrors).toHaveLength(0);
  });
});

describe('autoRun validation', () => {
  test('warns when autoRun omitted on non-gate step', () => {
    const errors = validate(
      makeMachine({
        initial: 'a',
        states: {
          a: gateState({ ok: 'b' }),
          b: {
            meta: { type: 'context', executor: 'tool', prompt: 'test' } as StepMeta,
            on: { ok: 'finish' },
          },
          finish: { type: 'final' },
        },
      }),
    );
    const warnings = errors.filter((e) => e.severity === 'warning');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.step).toBe('b');
    expect(warnings[0]!.message).toContain('autoRun not set');
  });

  test('no warning on gate steps without autoRun', () => {
    const errors = validate(
      makeMachine({
        initial: 'a',
        states: {
          a: gateState({ ok: 'finish' }),
          finish: { type: 'final' },
        },
      }),
    );
    const warnings = errors.filter((e) => e.severity === 'warning');
    expect(warnings).toHaveLength(0);
  });

  test('no warning when autoRun explicitly set', () => {
    const errors = validate(
      makeMachine({
        initial: 'a',
        states: {
          a: {
            meta: { type: 'context', executor: 'tool', prompt: 'test', autoRun: false } as StepMeta,
            on: { ok: 'finish' },
          },
          finish: { type: 'final' },
        },
      }),
    );
    const warnings = errors.filter((e) => e.severity === 'warning');
    expect(warnings).toHaveLength(0);
  });

  test('warnings are non-blocking — structural errors still reported', () => {
    // Use a code state WITHOUT autoRun set to trigger the autoRun warning
    const errors = validate(
      makeMachine({
        initial: 'a',
        states: {
          a: {
            meta: { type: 'code', executor: 'tool', prompt: 'code' } as StepMeta,
            on: { ok: 'finish' },
          },
          finish: { type: 'final' },
        },
      }),
    );
    const hardErrors = errors.filter((e) => e.severity !== 'warning');
    expect(hardErrors.some((e) => e.message.includes('no merge step'))).toBe(true);
    const warnings = errors.filter((e) => e.severity === 'warning');
    expect(warnings.some((e) => e.step === 'a' && e.message.includes('autoRun'))).toBe(true);
  });
});

describe('reserved step names', () => {
  test('rejects system interaction names as step names', () => {
    const errors = validate(
      makeMachine({
        initial: 'evaluate',
        states: {
          evaluate: contextState({ ok: 'finish' }),
          finish: { type: 'final' },
        },
      }),
    );
    expect(errors.some((e) => e.step === 'evaluate' && e.message.includes('reserved'))).toBe(true);
  });

  test('rejects breakdown as step name', () => {
    const errors = validate(
      makeMachine({
        initial: 'breakdown',
        states: {
          breakdown: contextState({ ok: 'finish' }),
          finish: { type: 'final' },
        },
      }),
    );
    expect(errors.some((e) => e.message.includes('reserved'))).toBe(true);
  });

  test('allows merge as step name (workflow-positionable system interaction)', () => {
    const errors = validate(
      makeMachine({
        initial: 'a',
        states: {
          a: codeState({ success: 'merge' }),
          merge: commandMergeState({ success: 'finish', fail: 'merge' }),
          finish: { type: 'final' },
        },
      }),
    );
    // The maxIterations check applies to merge self-loop
    const reservedErrors = errors.filter((e) => e.message.includes('reserved'));
    expect(reservedErrors).toHaveLength(0);
  });

  test('allows non-system names', () => {
    const errors = validate(
      makeMachine({
        initial: 'a',
        states: {
          a: contextState({ ok: 'finish' }),
          finish: { type: 'final' },
        },
      }),
    );
    expect(errors.some((e) => e.message.includes('reserved'))).toBe(false);
  });
});

describe('consumes ordering', () => {
  test('rejects consuming a step that comes after', () => {
    const errors = validate(
      makeMachine({
        initial: 'a',
        states: {
          a: {
            meta: { type: 'context', executor: 'tool', prompt: 'test', autoRun: true, consumes: ['b'] } as StepMeta,
            on: { ok: 'b' },
          },
          b: contextState({ ok: 'finish' }),
          finish: { type: 'final' },
        },
      }),
    );
    expect(errors.some((e) => e.step === 'a' && e.message.includes('does not precede'))).toBe(true);
  });

  test('rejects consuming unknown step', () => {
    const errors = validate(
      makeMachine({
        initial: 'a',
        states: {
          a: {
            meta: { type: 'context', executor: 'tool', prompt: 'test', autoRun: true, consumes: ['ghost'] } as StepMeta,
            on: { ok: 'finish' },
          },
          finish: { type: 'final' },
        },
      }),
    );
    expect(errors.some((e) => e.step === 'a' && e.message.includes('unknown step "ghost"'))).toBe(true);
  });

  test('allows consuming a preceding step', () => {
    const errors = validate(
      makeMachine({
        initial: 'a',
        states: {
          a: contextState({ ok: 'b' }),
          b: {
            meta: { type: 'code', executor: 'tool', prompt: 'code', autoRun: true, consumes: ['a'] } as StepMeta,
            on: { ok: 'm' },
          },
          m: commandMergeState({ ok: 'finish' }),
          finish: { type: 'final' },
        },
      }),
    );
    const consumeErrors = errors.filter((e) => e.message.includes('consume') || e.message.includes('precede'));
    expect(consumeErrors).toHaveLength(0);
  });
});

describe('compound state (loop) validation', () => {
  test('compound state without initial → error', () => {
    const errors = validate(
      makeMachine({
        initial: 'a',
        states: {
          a: {
            meta: { maxIterations: 3 } as StepMeta,
            // no `initial` field — compound but no entry defined
            states: {
              s: gateState({ ok: '#test.finish' }),
            },
            on: { done: 'finish' },
          },
          finish: { type: 'final' },
        },
      }),
    );
    // XState enforces initial at compile time; our validator surfaces it as an error
    expect(errors.length).toBeGreaterThan(0);
  });

  test('compound state without maxIterations → error', () => {
    const errors = validate(
      makeMachine({
        initial: 'a',
        states: {
          a: {
            meta: {} as StepMeta,
            initial: 's',
            states: {
              s: gateState({ ok: '#test.finish' }),
            },
            on: { done: 'finish' },
          },
          finish: { type: 'final' },
        },
      }),
    );
    expect(errors.some((e) => e.message.includes('maxIterations'))).toBe(true);
  });

  test('valid compound state passes', () => {
    const errors = validate(
      makeMachine({
        initial: 'a',
        states: {
          a: {
            meta: { maxIterations: 3 } as StepMeta,
            initial: 'inner',
            states: {
              inner: {
                meta: { type: 'context', executor: 'tool', prompt: 'test', autoRun: true, maxIterations: 5 } as StepMeta,
                on: { ok: '#test.finish', retry: 'inner' },
              },
            },
            on: { done: 'finish' },
          },
          finish: { type: 'final' },
        },
      }),
    );
    const hardErrors = errors.filter((e) => e.severity !== 'warning');
    expect(hardErrors).toHaveLength(0);
  });
});

describe('builtin presets', () => {
  test('standard machine config validates clean', () => {
    const standard = builtinWorkflows['standard'];
    if (!standard) throw new Error('standard workflow not found');
    const errors = validate(standard.machine.config);
    // No hard errors
    const hardErrors = errors.filter((e) => e.severity !== 'warning');
    expect(hardErrors).toHaveLength(0);
  });

  test('direct machine config validates clean', () => {
    const direct = builtinWorkflows['direct'];
    if (!direct) throw new Error('direct workflow not found');
    const errors = validate(direct.machine.config);
    const hardErrors = errors.filter((e) => e.severity !== 'warning');
    expect(hardErrors).toHaveLength(0);
  });
});
