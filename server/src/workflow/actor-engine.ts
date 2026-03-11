import { SYSTEM_JOB_PRIORITIES } from '@orca/types';
import type { AnyMachineSnapshot } from 'xstate';
import { createActor, pathToStateValue } from 'xstate';
import type { TaskEntry } from '../db/schema';
import { log } from '../shared/logger';
import * as questionStore from '../store/questions';
import * as taskStore from '../store/tasks';
import { shouldAutoRun } from './auto-run';
import type { StepCompletionResult, WorkflowEngineDeps } from './engine';
import { parsePath, resolveStepMeta } from './paths';
import type { CompiledWorkflow, StepMeta } from './types';

const DEFAULT_STEP_PRIORITY = 5;

// ---------------------------------------------------------------------------
// Snapshot navigation helpers
// ---------------------------------------------------------------------------

function stepPathFromSnapshot(snapshot: AnyMachineSnapshot): string | null {
  const value = snapshot.value;
  if (value == null) return null;
  if (typeof value === 'string') return value === 'finish' ? null : value;
  return flattenStateValue(value as Record<string, unknown>);
}

function flattenStateValue(value: Record<string, unknown>): string | null {
  const entries = Object.entries(value);
  if (entries.length === 0) return null;
  const [head, tail] = entries[0]!;
  if (head === 'finish') return null;
  if (typeof tail === 'string') {
    return tail === 'finish' ? head : `${head}.${tail}`;
  }
  if (tail && typeof tail === 'object') {
    const sub = flattenStateValue(tail as Record<string, unknown>);
    return sub ? `${head}.${sub}` : head;
  }
  return head;
}

// ---------------------------------------------------------------------------
// Public engine functions
// ---------------------------------------------------------------------------

export async function initWorkflowActor(
  taskId: string,
  workflowName: string | undefined,
  deps: WorkflowEngineDeps,
): Promise<{ workflow: CompiledWorkflow; startStep: StepMeta }> {
  const compiled = deps.workflowStore.resolve(workflowName);

  // Start actor — XState auto-enters initial states including compound states
  const actor = createActor(compiled.machine);
  actor.start();

  const snapshot = actor.getSnapshot();
  const persistedSnapshot = actor.getPersistedSnapshot();
  const currentStep = stepPathFromSnapshot(snapshot);
  actor.stop();

  if (!currentStep) {
    throw new Error(`workflow "${compiled.name}" has no initial step`);
  }

  const startMeta = resolveStepMeta(compiled.machine, currentStep).meta;

  await taskStore.updateTask(deps.db, undefined, taskId, {
    workflow: compiled.name,
    currentStep,
    workflowSnapshot: JSON.stringify(persistedSnapshot),
  });

  return { workflow: compiled, startStep: startMeta };
}

export async function completeStepActor(
  taskId: string,
  outcome: string,
  deps: WorkflowEngineDeps,
  payload?: Record<string, unknown>,
): Promise<StepCompletionResult> {
  const task = await taskStore.getTask(deps.db, taskId);
  if (!task) throw new Error(`task not found: ${taskId}`);

  const compiled = deps.workflowStore.resolve(task.workflow ?? undefined);
  const currentStepName = task.currentStep;
  if (!currentStepName) {
    throw new Error(`task ${taskId} has no current step`);
  }

  const resolved = resolveStepMeta(compiled.machine, currentStepName);
  const meta = resolved.meta;

  // Validate outcome
  if (meta.type === 'merge' && outcome === 'fail') {
    return { failed: true };
  }

  const stateNode = resolved.stateNode;
  const validOutcomes = Object.keys(stateNode.on ?? {});
  if (validOutcomes.length > 0 && !validOutcomes.includes(outcome)) {
    throw new Error(
      `outcome "${outcome}" not defined for step "${currentStepName}" in workflow "${compiled.name}"`,
    );
  }

  // Rehydrate actor from persisted snapshot, or synthesize one from currentStep for legacy tasks
  const snapshotJson = task.workflowSnapshot;
  let persistedSnapshot: unknown;
  if (snapshotJson) {
    persistedSnapshot = JSON.parse(snapshotJson);
  } else {
    // Legacy task with no snapshot — synthesize from currentStep via resolveState
    const stateValue = pathToStateValue(parsePath(currentStepName));
    const syntheticSnapshot = compiled.machine.resolveState({
      value: stateValue,
      context: { iterations: {} },
    });
    const tempActor = createActor(compiled.machine, {
      snapshot: syntheticSnapshot,
    });
    tempActor.start();
    persistedSnapshot = tempActor.getPersistedSnapshot();
    tempActor.stop();
    // Persist the synthesized snapshot so future calls work
    await taskStore.updateTask(deps.db, undefined, taskId, {
      workflowSnapshot: JSON.stringify(persistedSnapshot),
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const actor = createActor(compiled.machine, {
    snapshot: persistedSnapshot as any,
  });
  actor.start();

  const beforeSnapshot = actor.getSnapshot();
  const beforeStep = stepPathFromSnapshot(beforeSnapshot);
  const beforeContext = beforeSnapshot.context;
  actor.send({ type: outcome });

  const afterSnapshot = actor.getSnapshot();
  const newPersistedSnapshot = actor.getPersistedSnapshot();
  const newCurrentStep = stepPathFromSnapshot(afterSnapshot);
  const isFinished = afterSnapshot.status === 'done' || newCurrentStep == null;
  actor.stop();

  // Guard-blocked detection: when XState guard blocks a transition, both
  // state value AND context remain unchanged (event silently ignored).
  // A successful reenter self-transition keeps the same state value but
  // mutates context (incrementIteration fires), so we check both.
  const guardBlocked =
    !isFinished &&
    newCurrentStep === beforeStep &&
    afterSnapshot.context === beforeContext;
  if (guardBlocked) {
    log.warn('transition blocked by guard (iteration limit)', {
      taskId,
      step: newCurrentStep,
      outcome,
    });
    await taskStore.updateTask(deps.db, undefined, taskId, {
      status: 'stopped',
      currentStep: newCurrentStep,
      workflowSnapshot: JSON.stringify(newPersistedSnapshot),
    });
    await questionStore.createQuestion(deps.db, {
      taskId,
      question: `Step "${newCurrentStep}" reached max iterations on "${outcome}". Please provide guidance.`,
    });
    return { maxIterationsReached: true, gated: true };
  }

  // Build job payload from transition metadata
  const jobPayload: Record<string, unknown> = {};
  const includeOutput =
    compiled.transitionMeta[`${currentStepName}:${outcome}`]?.includeOutput;
  if (includeOutput && payload?.output) {
    jobPayload.feedback = payload.output;
  }

  if (isFinished) {
    await taskStore.updateTask(deps.db, undefined, taskId, {
      currentStep: null,
      workflowSnapshot: JSON.stringify(newPersistedSnapshot),
    });
    return { finished: true };
  }

  await taskStore.updateTask(deps.db, undefined, taskId, {
    currentStep: newCurrentStep,
    workflowSnapshot: JSON.stringify(newPersistedSnapshot),
  });

  const newMeta = resolveStepMeta(compiled.machine, newCurrentStep!).meta;
  if (newMeta.type === 'gate') {
    return { gated: true };
  }

  const auto = await shouldAutoRun(deps, taskId, newCurrentStep!);
  if (!auto) {
    return { gated: true };
  }

  const stepPriority =
    resolveStepMeta(compiled.machine, newCurrentStep!).meta.priority ??
    DEFAULT_STEP_PRIORITY;
  await deps.queue.enqueue({
    type: newCurrentStep!,
    taskId,
    priority: stepPriority,
    payload: Object.keys(jobPayload).length > 0 ? jobPayload : undefined,
  });

  log.info('workflow step transition', {
    taskId,
    from: currentStepName,
    outcome,
    to: newCurrentStep,
    engine: 'actor',
  });

  return { enqueued: { type: newCurrentStep!, taskId } };
}

export async function resumeUnblockedTaskActor(
  task: TaskEntry,
  deps: WorkflowEngineDeps,
): Promise<void> {
  const stepName = task.currentStep;
  if (stepName) {
    const auto = await shouldAutoRun(deps, task.id, stepName);
    if (!auto) return;

    const compiled = deps.workflowStore.resolve(task.workflow ?? undefined);
    const priority =
      resolveStepMeta(compiled.machine, stepName).meta.priority ??
      DEFAULT_STEP_PRIORITY;

    log.info('resuming unblocked task', { taskId: task.id, step: stepName });
    await deps.queue.enqueue({
      type: stepName,
      taskId: task.id,
      priority,
    });
    return;
  }

  log.info('resuming unblocked task with evaluate', { taskId: task.id });
  await deps.queue.enqueue({
    type: 'evaluate',
    taskId: task.id,
    priority: SYSTEM_JOB_PRIORITIES.evaluate,
  });
}
