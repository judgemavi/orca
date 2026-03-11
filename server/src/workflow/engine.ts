import type { EventSink } from '../api/ws';
import type { OrcaDrizzleDB } from '../db/connection';
import type { TaskEntry } from '../db/schema';
import type { JobQueue } from '../queue/queue';
import type { InteractionStore } from '../store/interactions';
import type { WorkflowStore } from './store';
import type { CompiledWorkflow, StepMeta } from './types';
import {
  completeStepActor,
  initWorkflowActor,
  resumeUnblockedTaskActor,
} from './actor-engine';

export { joinPath, parsePath, resolveStepMeta } from './paths';

export interface WorkflowEngineDeps {
  db: OrcaDrizzleDB;
  sink?: EventSink;
  queue: JobQueue;
  workflowStore: WorkflowStore;
  interactionStore?: InteractionStore;
}

export interface StepCompletionResult {
  enqueued?: { type: string; taskId: string };
  finished?: boolean;
  failed?: boolean;
  gated?: boolean;
  maxIterationsReached?: boolean;
}

export async function initWorkflow(
  taskId: string,
  workflowName: string | undefined,
  deps: WorkflowEngineDeps,
): Promise<{ workflow: CompiledWorkflow; startStep: StepMeta }> {
  return initWorkflowActor(taskId, workflowName, deps);
}

export async function completeStep(
  taskId: string,
  outcome: string,
  deps: WorkflowEngineDeps,
  payload?: Record<string, unknown>,
): Promise<StepCompletionResult> {
  return completeStepActor(taskId, outcome, deps, payload);
}

export async function resumeUnblockedTask(
  task: TaskEntry,
  deps: WorkflowEngineDeps,
): Promise<void> {
  return resumeUnblockedTaskActor(task, deps);
}
