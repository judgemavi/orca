import type { AnyStateMachine } from 'xstate';
import { z } from 'zod';

/** XState machine context for workflow state tracking */
export interface WorkflowContext {
  iterations: Record<string, number>;
}

/** Domain metadata on workflow states */
export interface StepMeta {
  type?: 'context' | 'decision' | 'code' | 'command' | 'gate' | 'merge';
  executor?: 'tool' | 'shell' | 'none';
  prompt?: string;
  command?: string;
  tool?: string;
  model?: string;
  consumes?: string[];
  maxIterations?: number;
  autoRun?: boolean;
  priority?: number;
}

/** Domain metadata on the root machine */
export interface WorkflowMeta {
  dependencyGate?: string;
}

/** Transition metadata */
export interface TransitionMeta {
  includeOutput?: boolean;
}

export interface WorkflowValidationError {
  step?: string;
  message: string;
  severity?: 'error' | 'warning';
}

/** A compiled workflow ready for use */
export interface CompiledWorkflow {
  machine: AnyStateMachine;
  name: string;
  /** "stepPath:event" → TransitionMeta, built at workflow creation time */
  transitionMeta: Record<string, TransitionMeta>;
}

// ---------------------------------------------------------------------------
// Zod schema for user-provided workflow JSON (XState machine config shape
// with StepMeta in state.meta fields)
// ---------------------------------------------------------------------------

const stepMetaSchema = z.object({
  type: z
    .enum(['context', 'decision', 'code', 'command', 'gate', 'merge'])
    .optional(),
  executor: z.enum(['tool', 'shell', 'none']).optional(),
  prompt: z.string().optional(),
  command: z.string().optional(),
  tool: z.string().optional(),
  model: z.string().optional(),
  consumes: z.array(z.string()).optional(),
  maxIterations: z.number().int().positive().optional(),
  autoRun: z.boolean().optional(),
  priority: z.number().int().min(0).optional(),
});

const workflowMetaSchema = z.object({
  dependencyGate: z.string().optional(),
});

const transitionTargetSchema = z.union([
  z.string(),
  z.object({
    target: z.string().optional(),
    meta: z.object({ includeOutput: z.boolean().optional() }).optional(),
  }),
]);

const stateNodeSchema: z.ZodType<WorkflowStateNodeInput> = z.lazy(() =>
  z.object({
    type: z.enum(['final']).optional(),
    meta: stepMetaSchema.optional(),
    initial: z.string().optional(),
    states: z.record(z.string(), stateNodeSchema).optional(),
    on: z.record(z.string(), transitionTargetSchema).optional(),
  }),
);

interface WorkflowStateNodeInput {
  type?: 'final';
  meta?: z.infer<typeof stepMetaSchema>;
  initial?: string;
  states?: Record<string, WorkflowStateNodeInput>;
  on?: Record<string, z.infer<typeof transitionTargetSchema>>;
}

export const workflowMachineConfigSchema = z.object({
  id: z.string().min(1),
  initial: z.string().min(1),
  meta: workflowMetaSchema.optional(),
  states: z.record(z.string(), stateNodeSchema),
});

export type WorkflowMachineConfigInput = z.infer<
  typeof workflowMachineConfigSchema
>;
