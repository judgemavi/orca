import type { OrcaDrizzleDB } from '../db/connection';
import type { InteractionStore } from '../store/interactions';
import * as taskStore from '../store/tasks';
import { resolveStepMeta, type AnyStateNode } from './paths';
import { stringifyWorkflowOutput } from './output';
import type { WorkflowStore } from './store';
import type { StepMeta } from './types';

export async function loadCurrentTaskStep(
  taskId: string,
  deps: {
    db: OrcaDrizzleDB;
    workflowStore: WorkflowStore;
  },
) {
  const task = await taskStore.getTask(deps.db, taskId).catch(() => null);
  if (!task) throw new Error(`task not found: ${taskId}`);
  if (!task.currentStep) throw new Error('task has no current step');
  const currentStep = task.currentStep;

  const compiled = deps.workflowStore.resolve(task.workflow ?? undefined);
  let meta: StepMeta;
  let stateNode: AnyStateNode | undefined;
  try {
    const resolved = resolveStepMeta(compiled.machine, currentStep);
    meta = resolved.meta;
    stateNode = resolved.stateNode;
  } catch {
    throw new Error(`step "${currentStep}" not found`);
  }

  return { task, compiled, currentStep, step: meta, stateNode };
}

export async function createSyntheticStepInteraction(
  interactionStore: InteractionStore,
  args: {
    taskId: string;
    stepName: string;
    outcome: string;
    output?: string;
    data?: Record<string, unknown>;
  },
): Promise<string> {
  const interaction = await interactionStore.begin({
    taskId: args.taskId,
    type: args.stepName,
    tool: 'manual',
  });

  await interactionStore.finish(interaction.id, {
    status: 'completed',
    output: stringifyWorkflowOutput({
      result: args.outcome,
      output: args.output,
      data: args.data,
    }),
    durationMs: 0,
  });

  return interaction.id;
}
