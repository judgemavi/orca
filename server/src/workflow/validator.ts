import type { AnyStateMachine } from 'xstate';
import { createMachine } from 'xstate';
import type { Config } from '../db/schema';
import type { ToolPluginRegistry } from '../plugin/registry';
import { SYSTEM_INTERACTION_TYPES } from '../types/api';
import type { AnyStateNode } from './paths';
import type {
  StepMeta,
  WorkflowMachineConfigInput,
  WorkflowValidationError,
} from './types';
import { workflowMachineConfigSchema } from './types';

// Raw parsed state node (from Zod schema)
type RawStateNode = NonNullable<WorkflowMachineConfigInput['states'][string]>;

export function validateWorkflow(
  raw: unknown,
  config: Config,
  registry: ToolPluginRegistry,
): WorkflowValidationError[] {
  const errors: WorkflowValidationError[] = [];

  // 1. Schema parse
  const parsed = workflowMachineConfigSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push({ message: `${issue.path.join('.')}: ${issue.message}` });
    }
    return errors;
  }

  const machineConfig = parsed.data;

  // 2. Try to compile with XState to catch structural errors
  let machine: AnyStateMachine;
  try {
    machine = createMachine(
      machineConfig as Parameters<typeof createMachine>[0],
    );
  } catch (err) {
    errors.push({
      message: `XState compilation error: ${err instanceof Error ? err.message : String(err)}`,
    });
    return errors;
  }

  const rawStates = machineConfig.states;
  const topLevelNames = new Set(
    Object.keys(rawStates).filter((k) => rawStates[k]?.type !== 'final'),
  );

  // 3. Initial state must exist in states
  const initial = machineConfig.initial;
  if (!topLevelNames.has(initial) && initial !== 'finish') {
    errors.push({
      message: `initial state "${initial}" not found in states`,
    });
    return errors;
  }

  // 4. dependencyGate must reference an existing top-level state
  const dependencyGate = machineConfig.meta?.dependencyGate;
  if (dependencyGate && !topLevelNames.has(dependencyGate)) {
    errors.push({
      message: `dependencyGate "${dependencyGate}" not found in states`,
    });
  }

  // 5. Validate all states recursively (using raw config to preserve original field values)
  validateStateNodes(rawStates, [], topLevelNames, errors, config, registry);

  // Only skip graph checks if there are hard (non-warning) errors
  if (errors.some((e) => e.severity !== 'warning')) return errors;

  // 6. Reachability: all states must reach a final state (uses compiled root for id-ref resolution)
  const compiledRoot = machine.root as unknown as AnyStateNode;
  checkReachability(compiledRoot, [], errors);

  // 7. Code step requires merge downstream
  const hasCode = hasCodeRawNode(rawStates);
  const hasMerge = hasMergeRawNode(rawStates);
  if (hasCode && !hasMerge) {
    errors.push({ message: 'workflow has code steps but no merge step' });
  }

  // 8. No code steps after merge
  if (hasMerge) {
    checkNoCodeAfterMerge(compiledRoot, machineConfig.initial, errors);
  }

  // 9. Reserved system interaction names
  const WORKFLOW_POSITIONABLE = new Set(['merge']);
  const reservedNames = new Set<string>(
    SYSTEM_INTERACTION_TYPES.filter((t) => !WORKFLOW_POSITIONABLE.has(t)),
  );
  collectAllRawStateNames(rawStates, []).forEach(({ name, path }) => {
    if (reservedNames.has(name)) {
      errors.push({
        step: path || name,
        message: `"${name}" is a reserved system interaction name and cannot be used as a workflow step`,
      });
    }
  });

  // 10. Consume ordering (top-level only)
  checkConsumeOrdering(compiledRoot, machineConfig.initial, errors);

  return errors;
}

// ---------------------------------------------------------------------------
// Recursive state validation (raw config)
// ---------------------------------------------------------------------------

function getRawTransitionNames(node: RawStateNode): string[] {
  return Object.keys(node.on ?? {});
}

function validateStateNodes(
  states: Record<string, RawStateNode>,
  path: string[],
  scopeNames: Set<string>,
  errors: WorkflowValidationError[],
  config: Config,
  registry: ToolPluginRegistry,
): void {
  for (const [name, child] of Object.entries(states)) {
    if (child.type === 'final') continue;

    const fullPath = path.length > 0 ? [...path, name].join('.') : name;
    const meta = (child.meta ?? {}) as StepMeta;
    const innerStates = child.states
      ? Object.entries(child.states).filter(([, s]) => s?.type !== 'final')
      : [];
    const isCompound = innerStates.length > 0;

    if (isCompound) {
      validateCompoundState(
        name,
        fullPath,
        child,
        meta,
        errors,
        config,
        registry,
      );
      continue;
    }

    if (!meta.type) {
      errors.push({ step: fullPath, message: 'meta.type is required' });
      continue;
    }

    if (meta.type === 'merge') {
      const events = getRawTransitionNames(child);
      if (events.length === 0) {
        errors.push({
          step: fullPath,
          message: 'merge step must have at least one transition',
        });
      }
    } else {
      if (!meta.executor) {
        errors.push({
          step: fullPath,
          message: 'executor is required for non-merge steps',
        });
      }

      if (
        (meta.type === 'context' || meta.type === 'decision') &&
        meta.executor !== 'tool' &&
        meta.executor !== 'none'
      ) {
        errors.push({
          step: fullPath,
          message: `${meta.type} step must use executor "tool" or "none", got "${meta.executor}"`,
        });
      }
      if (meta.type === 'code' && meta.executor !== 'tool') {
        errors.push({
          step: fullPath,
          message: `code step must use executor "tool", got "${meta.executor}"`,
        });
      }
      if (meta.type === 'command' && meta.executor !== 'shell') {
        errors.push({
          step: fullPath,
          message: `command step must use executor "shell", got "${meta.executor}"`,
        });
      }
      if (meta.type === 'gate' && meta.executor !== 'none') {
        errors.push({
          step: fullPath,
          message: `gate step must use executor "none", got "${meta.executor}"`,
        });
      }

      if (meta.executor === 'tool' && !meta.prompt) {
        errors.push({
          step: fullPath,
          message: 'prompt required for tool executor',
        });
      }
      if (meta.executor === 'shell' && !meta.command) {
        errors.push({
          step: fullPath,
          message: 'command required for shell executor',
        });
      }

      const events = getRawTransitionNames(child);
      if (events.length === 0) {
        errors.push({
          step: fullPath,
          message: 'must define at least one branch',
        });
      }
    }

    if (meta.executor === 'tool' && meta.tool) {
      const tools = registry.available();
      if (!tools.includes(meta.tool)) {
        errors.push({
          step: fullPath,
          message: `tool "${meta.tool}" not available`,
        });
      } else if (meta.model) {
        const models = registry.get(meta.tool)?.models() ?? [];
        if (models.length > 0 && !models.includes(meta.model)) {
          errors.push({
            step: fullPath,
            message: `model "${meta.model}" not supported by tool "${meta.tool}"`,
          });
        }
      }
    }

    if (meta.autoRun === undefined && meta.type !== 'gate') {
      errors.push({
        step: fullPath,
        severity: 'warning',
        message:
          'autoRun not set — defaults to true. Set explicitly to avoid unintended auto-execution',
      });
    }
  }
}

function validateCompoundState(
  name: string,
  fullPath: string,
  node: RawStateNode,
  meta: StepMeta,
  errors: WorkflowValidationError[],
  config: Config,
  registry: ToolPluginRegistry,
): void {
  if (meta.executor) {
    errors.push({
      step: fullPath,
      message: 'compound state must not have "executor"',
    });
  }
  if (meta.prompt) {
    errors.push({
      step: fullPath,
      message: 'compound state must not have "prompt"',
    });
  }
  if (meta.command) {
    errors.push({
      step: fullPath,
      message: 'compound state must not have "command"',
    });
  }

  if (!node.initial) {
    errors.push({ step: fullPath, message: 'loop step must define "entry"' });
  }

  const innerStates = Object.entries(node.states ?? {}).filter(
    ([, s]) => s?.type !== 'final',
  );
  if (innerStates.length === 0) {
    errors.push({
      step: fullPath,
      message: 'loop step must define non-empty "steps"',
    });
  }
  if (!meta.maxIterations) {
    errors.push({
      step: fullPath,
      message: 'loop step must define "maxIterations"',
    });
  }

  // Exit transitions can be on the compound state itself OR on inner states via #id.state refs
  // We don't enforce outgoing transitions at this level since inner states handle exits

  if (node.initial) {
    const innerStateNames = innerStates.map(([k]) => k);
    if (!innerStateNames.includes(node.initial)) {
      errors.push({
        step: fullPath,
        message: `loop entry "${node.initial}" not found in loop steps`,
      });
    }
  }

  const innerNames = new Set(innerStates.map(([k]) => k));
  validateStateNodes(
    node.states ?? {},
    fullPath.split('.'),
    innerNames,
    errors,
    config,
    registry,
  );
}

// ---------------------------------------------------------------------------
// Graph helpers (compiled root)
// ---------------------------------------------------------------------------

function collectAllRawStateNames(
  states: Record<string, RawStateNode>,
  path: string[],
): Array<{ name: string; path: string }> {
  const results: Array<{ name: string; path: string }> = [];
  for (const [name, child] of Object.entries(states)) {
    if (child.type === 'final') continue;
    const fullPath = [...path, name].join('.');
    results.push({ name, path: fullPath });
    if (child.states) {
      results.push(...collectAllRawStateNames(child.states, [...path, name]));
    }
  }
  return results;
}

function hasCodeRawNode(states: Record<string, RawStateNode>): boolean {
  for (const child of Object.values(states)) {
    if (child.type === 'final') continue;
    const meta = (child.meta ?? {}) as StepMeta;
    if (meta.type === 'code') return true;
    if (child.states && hasCodeRawNode(child.states)) return true;
  }
  return false;
}

function hasMergeRawNode(states: Record<string, RawStateNode>): boolean {
  for (const child of Object.values(states)) {
    if (child.type === 'final') continue;
    const meta = (child.meta ?? {}) as StepMeta;
    if (meta.type === 'merge') return true;
    if (meta.type === 'command' && meta.command === 'merge') return true;
    if (child.states && hasMergeRawNode(child.states)) return true;
  }
  return false;
}

function topLevelFromStateNode(
  stateNode: { id?: string; key?: string },
  root: AnyStateNode,
): string | null {
  if (stateNode.id) {
    const parts = stateNode.id.split('.');
    const topLevel = parts[1];
    if (topLevel && root.states && topLevel in root.states) {
      return topLevel;
    }
  }
  if (stateNode.key && root.states && stateNode.key in root.states) {
    return stateNode.key;
  }
  return null;
}

function getTransitionTargets(
  node: AnyStateNode,
  root: AnyStateNode,
): string[] {
  const targets: string[] = [];
  for (const transition of Object.values(node.on ?? {})) {
    if (Array.isArray(transition)) {
      // Compiled XState node: each element is a transition definition with .target array of state nodes
      for (const t of transition) {
        const def = t as { target?: Array<{ id?: string; key?: string }> };
        for (const tgt of def.target ?? []) {
          const top = topLevelFromStateNode(tgt, root);
          if (top) targets.push(top);
        }
      }
    } else if (typeof transition === 'string') {
      const top = transition.startsWith('#')
        ? resolveIdRef(transition, root)
        : (transition.split('.')[0] ?? null);
      if (top) targets.push(top);
    } else if (transition && typeof transition === 'object') {
      const t = transition as { target?: string };
      if (t.target) {
        const top = t.target.startsWith('#')
          ? resolveIdRef(t.target, root)
          : (t.target.split('.')[0] ?? null);
        if (top) targets.push(top);
      }
    }
  }
  return targets;
}

function resolveIdRef(idRef: string, root: AnyStateNode): string | null {
  const withoutHash = idRef.slice(1);
  for (const name of Object.keys(root.states ?? {})) {
    if (withoutHash === name || withoutHash.endsWith(`.${name}`)) {
      return name;
    }
  }
  return null;
}

function checkReachability(
  root: AnyStateNode,
  _path: string[],
  errors: WorkflowValidationError[],
): void {
  const adjacency = new Map<string, Set<string>>();

  for (const [name, child] of Object.entries(root.states ?? {})) {
    if (child.type === 'final') continue;
    const targets = new Set<string>();

    for (const target of getTransitionTargets(child, root)) {
      targets.add(target);
    }
    // For compound states, also collect targets from inner states
    if (child.states) {
      for (const innerChild of Object.values(child.states)) {
        for (const target of getTransitionTargets(innerChild, root)) {
          targets.add(target);
        }
      }
    }

    adjacency.set(name, targets);
  }

  const reverseAdj = new Map<string, Set<string>>();
  reverseAdj.set('finish', new Set());
  for (const [name, targets] of adjacency.entries()) {
    for (const target of targets) {
      if (!reverseAdj.has(target)) reverseAdj.set(target, new Set());
      reverseAdj.get(target)!.add(name);
    }
  }

  const reaches = new Set<string>();
  const queue = ['finish'];
  while (queue.length > 0) {
    const current = queue.pop()!;
    const sources = reverseAdj.get(current);
    if (!sources) continue;
    for (const src of sources) {
      if (!reaches.has(src)) {
        reaches.add(src);
        queue.push(src);
      }
    }
  }

  for (const name of adjacency.keys()) {
    if (name !== 'finish' && !reaches.has(name)) {
      errors.push({
        step: name,
        message: 'step cannot reach "finish" via any path',
      });
    }
  }

  detectAndCheckCycles(adjacency, root, errors);
}

function detectAndCheckCycles(
  adjacency: Map<string, Set<string>>,
  root: AnyStateNode,
  errors: WorkflowValidationError[],
): void {
  const visited = new Set<string>();
  const stack = new Set<string>();
  const path: string[] = [];
  const cycles: string[][] = [];

  function dfs(name: string) {
    if (stack.has(name)) {
      const idx = path.indexOf(name);
      if (idx >= 0) cycles.push([...path.slice(idx), name]);
      return;
    }
    if (visited.has(name)) return;
    visited.add(name);
    stack.add(name);
    path.push(name);
    for (const target of adjacency.get(name) ?? []) {
      if (target !== 'finish') dfs(target);
    }
    path.pop();
    stack.delete(name);
  }

  for (const name of adjacency.keys()) dfs(name);

  for (const cycle of cycles) {
    const stepsInCycle = cycle.slice(0, -1);
    const guarded = stepsInCycle.some((s) => {
      const meta = (root.states?.[s]?.meta ?? {}) as StepMeta;
      return meta.maxIterations != null;
    });
    if (!guarded) {
      errors.push({
        step: stepsInCycle[0],
        message: `cycle detected [${stepsInCycle.join(' → ')}] without maxIterations on any step in the cycle`,
      });
    }
  }
}

function checkNoCodeAfterMerge(
  root: AnyStateNode,
  initial: string,
  errors: WorkflowValidationError[],
): void {
  let mergeName: string | null = null;
  for (const [name, child] of Object.entries(root.states ?? {})) {
    const meta = (child.meta ?? {}) as StepMeta;
    if (
      meta.type === 'merge' ||
      (meta.type === 'command' && meta.command === 'merge')
    ) {
      mergeName = name;
      break;
    }
  }
  if (!mergeName) return;

  const adjacency = new Map<string, Set<string>>();
  for (const [name, child] of Object.entries(root.states ?? {})) {
    if (child.type === 'final') continue;
    const targets = new Set<string>();
    for (const target of getTransitionTargets(child, root)) {
      targets.add(target);
    }
    adjacency.set(name, targets);
  }

  const reachableFromMerge = new Set<string>();
  const queue: string[] = Array.from(adjacency.get(mergeName) ?? []).filter(
    (t) => t !== 'finish',
  );
  for (const t of queue) reachableFromMerge.add(t);

  while (queue.length > 0) {
    const current = queue.pop()!;
    for (const target of adjacency.get(current) ?? []) {
      if (target !== 'finish' && !reachableFromMerge.has(target)) {
        reachableFromMerge.add(target);
        queue.push(target);
      }
    }
  }

  for (const name of reachableFromMerge) {
    const child = root.states?.[name];
    if (!child) continue;
    const meta = (child.meta ?? {}) as StepMeta;
    if (meta.type === 'code') {
      errors.push({
        step: name,
        message: `code step "${name}" is reachable after merge step "${mergeName}"`,
      });
    }
    if (child.states && hasCodeCompiledNode(child)) {
      errors.push({
        step: name,
        message: `loop "${name}" contains code steps and is reachable after merge step "${mergeName}"`,
      });
    }
  }
}

function hasCodeCompiledNode(node: AnyStateNode): boolean {
  for (const child of Object.values(node.states ?? {})) {
    if (child.type === 'final') continue;
    const meta = (child.meta ?? {}) as StepMeta;
    if (meta.type === 'code') return true;
    if (child.states && hasCodeCompiledNode(child)) return true;
  }
  return false;
}

function checkConsumeOrdering(
  root: AnyStateNode,
  initial: string,
  errors: WorkflowValidationError[],
): void {
  const adjacency = new Map<string, Set<string>>();
  for (const [name, child] of Object.entries(root.states ?? {})) {
    if (child.type === 'final') continue;
    const targets = new Set<string>();
    for (const target of getTransitionTargets(child, root)) {
      targets.add(target);
    }
    adjacency.set(name, targets);
  }

  const order = new Map<string, number>();
  const queue: string[] = [initial];
  order.set(initial, 0);
  while (queue.length > 0) {
    const current = queue.shift()!;
    const currentOrder = order.get(current) ?? 0;
    for (const target of adjacency.get(current) ?? []) {
      if (target === 'finish') continue;
      if (!order.has(target)) {
        order.set(target, currentOrder + 1);
        queue.push(target);
      }
    }
  }

  const topNames = new Set(
    Object.keys(root.states ?? {}).filter(
      (k) => root.states![k]?.type !== 'final',
    ),
  );

  for (const [name, child] of Object.entries(root.states ?? {})) {
    if (child.type === 'final') continue;
    const meta = (child.meta ?? {}) as StepMeta;
    if (!meta.consumes || meta.consumes.length === 0) continue;
    const myOrder = order.get(name) ?? Infinity;

    for (const consumed of meta.consumes) {
      const bareName = consumed.includes('.')
        ? consumed.split('.')[0]!
        : consumed;
      if (!topNames.has(bareName)) {
        errors.push({
          step: name,
          message: `consumes unknown step "${consumed}"`,
        });
        continue;
      }
      const consumedOrder = order.get(bareName) ?? Infinity;
      if (consumedOrder >= myOrder) {
        errors.push({
          step: name,
          message: `cannot consume step "${consumed}" — it does not precede "${name}" in the workflow`,
        });
      }
    }
  }
}
