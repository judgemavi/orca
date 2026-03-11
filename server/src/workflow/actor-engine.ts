import { JOB_PRIORITIES } from '@orca/types';
import { createActor, pathToStateValue } from 'xstate';
import type { AnyMachineSnapshot } from 'xstate';
import type { TaskEntry } from '../db/schema';
import * as questionStore from '../store/questions';
import * as taskStore from '../store/tasks';
import { log } from '../shared/logger';
import type { CompiledWorkflow, StepMeta, WorkflowContext } from './types';
import { extractInitialName, joinPath, parsePath, resolveStepMeta } from './paths';
import { shouldAutoRun } from './auto-run';
import type { StepCompletionResult, WorkflowEngineDeps } from './engine';

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
    const tempActor = createActor(compiled.machine, { snapshot: syntheticSnapshot });
    tempActor.start();
    persistedSnapshot = tempActor.getPersistedSnapshot();
    tempActor.stop();
    // Persist the synthesized snapshot so future calls work
    await taskStore.updateTask(deps.db, undefined, taskId, {
      workflowSnapshot: JSON.stringify(persistedSnapshot),
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const actor = createActor(compiled.machine, { snapshot: persistedSnapshot as any });
  actor.start();

  actor.send({ type: outcome });

  const afterSnapshot = actor.getSnapshot();
  const newPersistedSnapshot = actor.getPersistedSnapshot();
  const newCurrentStep = stepPathFromSnapshot(afterSnapshot);
  const isFinished = afterSnapshot.status === 'done' || newCurrentStep == null;
  actor.stop();

  // Extract iteration context from updated snapshot (may be undefined for machines without setup())
  const rawContext = afterSnapshot.context as WorkflowContext | undefined;
  const context: WorkflowContext = rawContext?.iterations != null
    ? (rawContext as WorkflowContext)
    : { iterations: {} };

  // Check step-level iteration limits on the destination step
  if (!isFinished && newCurrentStep) {
    const newMeta = resolveStepMeta(compiled.machine, newCurrentStep).meta;
    if (newMeta.maxIterations) {
      const count = context.iterations[newCurrentStep] ?? 0;
      if (count > newMeta.maxIterations) {
        log.warn('max iterations reached, forcing gate', {
          taskId,
          step: newCurrentStep,
          iterations: count,
          max: newMeta.maxIterations,
        });
        await taskStore.updateTask(deps.db, undefined, taskId, {
          status: 'stopped',
          currentStep: newCurrentStep,
          workflowSnapshot: JSON.stringify(newPersistedSnapshot),
        });
        await questionStore.createQuestion(deps.db, {
          taskId,
          question: `Step "${newCurrentStep}" reached max iterations (${newMeta.maxIterations}). Please provide guidance.`,
        });
        return { maxIterationsReached: true, gated: true };
      }
    }

    // Check compound (loop) iteration limits
    const newResolved = resolveStepMeta(compiled.machine, newCurrentStep);
    if (newResolved.compoundMeta?.maxIterations && newResolved.compoundPath) {
      const compoundPrefix = joinPath(newResolved.compoundPath);
      const compoundResolved = resolveStepMeta(compiled.machine, compoundPrefix);
      const initialName = extractInitialName(compoundResolved.stateNode.initial);
      if (initialName) {
        const entryPath = joinPath([...newResolved.compoundPath, initialName]);
        const loopCount = context.iterations[entryPath] ?? 0;
        if (loopCount > newResolved.compoundMeta.maxIterations) {
          log.warn('loop max iterations reached, forcing gate', {
            taskId,
            loop: compoundPrefix,
            iterations: loopCount,
            max: newResolved.compoundMeta.maxIterations,
          });
          await taskStore.updateTask(deps.db, undefined, taskId, {
            status: 'stopped',
            currentStep: newCurrentStep,
            workflowSnapshot: JSON.stringify(newPersistedSnapshot),
          });
          await questionStore.createQuestion(deps.db, {
            taskId,
            question: `Loop "${compoundPrefix}" reached max iterations (${newResolved.compoundMeta.maxIterations}). Please provide guidance.`,
          });
          return { maxIterationsReached: true, gated: true };
        }
      }
    }
  }

  // Build job payload from transition metadata
  const jobPayload: Record<string, unknown> = {};
  const includeOutput = compiled.transitionMeta[`${currentStepName}:${outcome}`]?.includeOutput;
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

  await deps.queue.enqueue({
    type: newCurrentStep!,
    taskId,
    priority: JOB_PRIORITIES[newCurrentStep! as keyof typeof JOB_PRIORITIES] ?? 5,
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

    log.info('resuming unblocked task', { taskId: task.id, step: stepName });
    await deps.queue.enqueue({
      type: stepName,
      taskId: task.id,
      priority: JOB_PRIORITIES[stepName as keyof typeof JOB_PRIORITIES] ?? 5,
    });
    return;
  }

  log.info('resuming unblocked task with evaluate', { taskId: task.id });
  await deps.queue.enqueue({
    type: 'evaluate',
    taskId: task.id,
    priority: JOB_PRIORITIES.evaluate,
  });
}
