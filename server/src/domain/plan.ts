import type { ToolPluginRegistry } from '../plugin/registry';
import { createInteractionRunner } from '../shared/interaction-runner';
import type { InteractionStore } from '../store/interactions';
import type { Config, ProposedTask } from '../types';
import { runTool } from '../worker/worker';

interface RunPlanInput {
  repoDir: string;
  taskID: string;
  title: string;
  description: string;
  feedback?: string;
  memoryContext?: string;
  config: Config;
  registry: ToolPluginRegistry;
  interactions: InteractionStore;
  toolOverride?: string;
  modelOverride?: string;
}

interface RunPlanResult {
  plan: string;
  tool: string;
  model: string;
  interactionId: string;
}

export async function runPlan(input: RunPlanInput): Promise<RunPlanResult> {
  const runInteraction = await createInteractionRunner({
    config: input.config,
    registry: input.registry,
    repoDir: input.repoDir,
    interactions: input.interactions,
    runTool,
  });

  const memoryContext = input.memoryContext?.trim() || '(no retrieved context)';
  const title = input.title.trim() || 'Implement task';
  const description =
    input.description.trim() || 'No extra description was provided.';
  const feedback = input.feedback?.trim();

  const {
    result: plan,
    interactionId,
    tool,
    model,
  } = await runInteraction(
    {
      taskId: input.taskID,
      type: 'plan',
      promptName: 'plan',
      promptArgs: [memoryContext, title, description],
      extraContext: feedback ? `\n\n## Reviewer Feedback\n${feedback}` : '',
      toolOverride: input.toolOverride ?? '',
      modelOverride: input.modelOverride ?? '',
      resolveErrorMessage: 'unable to resolve plan tool/model',
      exitErrorLabel: 'plan',
    },
    (output) => {
      if (!output.trim()) {
        throw new Error('plan returned empty output');
      }
      return stripPreamble(output);
    },
  );

  return {
    plan,
    tool,
    model,
    interactionId,
  };
}

function stripPreamble(raw: string): string {
  const idx = raw.indexOf('## ');
  if (idx <= 0) return raw.trim();
  return raw.slice(idx).trim();
}

export function generateGlobalPlan(goal: string): ProposedTask[] {
  const normalized = goal.trim() || 'Goal';
  return [
    {
      title: `Analyze: ${normalized}`,
      description: `Review repository context for goal: ${normalized}`,
      dependsOnIndices: [],
      suggestedTool: 'claude',
    },
    {
      title: `Implement: ${normalized}`,
      description: `Apply focused implementation for goal: ${normalized}`,
      dependsOnIndices: [0],
      suggestedTool: 'claude',
    },
    {
      title: `Validate: ${normalized}`,
      description: `Run verification and prepare for review for goal: ${normalized}`,
      dependsOnIndices: [1],
      suggestedTool: 'claude',
    },
  ];
}
