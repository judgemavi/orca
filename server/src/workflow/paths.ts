import type { AnyStateMachine } from 'xstate';
import type { StepMeta, TransitionMeta } from './types';

/**
 * Extract the initial state name from XState's `initial` field.
 * In compiled machines it's an `InitialTransitionDefinition` with a `target` array.
 * In raw config it's a plain string.
 */
export function extractInitialName(initial: unknown): string | null {
  if (typeof initial === 'string') return initial || null;
  if (initial && typeof initial === 'object') {
    // XState v5 InitialTransitionDefinition: { target: StateNode[] }
    const asObj = initial as { target?: unknown };
    if (Array.isArray(asObj.target) && asObj.target.length > 0) {
      const first = asObj.target[0] as { id?: string; key?: string } | undefined;
      return first?.key ?? first?.id?.split(':').pop() ?? null;
    }
    // Fallback: { target: string }
    if (typeof asObj.target === 'string') return asObj.target || null;
  }
  return null;
}

export function parsePath(step: string): string[] {
  return step.split('.');
}

export function joinPath(segments: string[]): string {
  return segments.join('.');
}

export interface ResolvedStep {
  meta: StepMeta;
  stateNode: AnyStateNode;
  parentPath: string[];
  /** If inside a compound state (loop), the compound state's meta and path */
  compoundMeta?: StepMeta;
  compoundPath?: string[];
}

// XState internal state node shape (enough for our needs)
export interface AnyStateNode {
  id?: string;
  type?: string;
  meta?: unknown;
  states?: Record<string, AnyStateNode>;
  on?: Record<string, unknown>;
  // `initial` is a string in raw config, but a complex object in compiled XState nodes
  initial?: unknown;
  transitions?: Map<string, unknown[]>;
}

/**
 * Walk XState machine's state tree to resolve a dotted path like "implement.code".
 * Returns the step meta, state node, parent path, and enclosing compound state info.
 */
export function resolveStepMeta(
  machine: AnyStateMachine,
  dottedPath: string,
): ResolvedStep {
  const segments = parsePath(dottedPath);
  let stateNode: AnyStateNode = machine.root as unknown as AnyStateNode;
  let parentPath: string[] = [];
  let compoundMeta: StepMeta | undefined;
  let compoundPath: string[] | undefined;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const child = stateNode.states?.[seg];
    if (!child) {
      throw new Error(`step "${dottedPath}" not found in workflow "${machine.id}"`);
    }

    if (i < segments.length - 1) {
      // Intermediate compound state (loop equivalent)
      compoundMeta = (child.meta ?? {}) as StepMeta;
      compoundPath = [...parentPath, seg];
      parentPath = [...parentPath, seg];
    }
    stateNode = child;
  }

  const meta = (stateNode.meta ?? {}) as StepMeta;
  return { meta, stateNode, parentPath, compoundMeta, compoundPath };
}

/**
 * Get all event names from a state node's `on` handler.
 * Works on both raw config nodes and compiled XState state nodes.
 */
export function getTransitionEvents(stateNode: AnyStateNode): string[] {
  // Compiled XState nodes have a `transitions` Map
  if (stateNode.transitions instanceof Map) {
    return Array.from(stateNode.transitions.keys());
  }
  // Raw config shape has `on` as a plain object
  return Object.keys(stateNode.on ?? {});
}

/**
 * Walk all states in a machine and build a transitionMeta map
 * keyed by "stepPath:event".
 */
export function buildTransitionMeta(
  machine: AnyStateMachine,
): Record<string, TransitionMeta> {
  const result: Record<string, TransitionMeta> = {};
  walkStatesForMeta(machine.root as unknown as AnyStateNode, [], result);
  return result;
}

function walkStatesForMeta(
  node: AnyStateNode,
  path: string[],
  result: Record<string, TransitionMeta>,
): void {
  for (const [stateName, child] of Object.entries(node.states ?? {})) {
    const childPath = [...path, stateName];
    const stepPath = joinPath(childPath);

    // Walk `on` transitions — compiled nodes have arrays, raw config has plain objects
    for (const [event, transition] of Object.entries(child.on ?? {})) {
      if (Array.isArray(transition)) {
        // Compiled XState node: array of transition definitions
        for (const t of transition) {
          const meta = (t as { meta?: TransitionMeta }).meta;
          if (meta) {
            result[`${stepPath}:${event}`] = meta;
            break;
          }
        }
      } else if (transition && typeof transition === 'object') {
        // Raw config: plain object
        const t = transition as { meta?: TransitionMeta };
        if (t.meta) {
          result[`${stepPath}:${event}`] = t.meta;
        }
      }
    }

    // Recurse into nested states
    if (child.states) {
      walkStatesForMeta(child, childPath, result);
    }
  }
}
