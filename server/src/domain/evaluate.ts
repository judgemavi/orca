import type { DriverRegistry } from '../driver/registry';
import { createPhaseRunner } from '../shared/phase-runner';
import type { InteractionStore } from '../store/interactions';
import type { Config, Task, TaskEvaluation } from '../types';
import { PHASES } from '../types';
import { runTool } from '../worker/worker';
import { readExploreContext } from './explore';
import { extractJSONObject } from './llm';

export interface EvaluateOptions {
  repoDir: string;
  config?: Config;
  registry?: DriverRegistry;
  interactions?: InteractionStore;
  toolOverride?: string;
  modelOverride?: string;
}

export async function evaluateTask(
  task: Pick<Task, 'id' | 'title' | 'description'>,
  options: EvaluateOptions,
): Promise<TaskEvaluation> {
  const context = await readExploreContext(options.repoDir);
  const runPhase = await createPhaseRunner({
    config: options.config,
    registry: options.registry,
    repoDir: options.repoDir,
    interactions: options.interactions,
    runTool,
  });
  const { result: evaluation } = await runPhase(
    {
      taskId: task.id,
      taskRunId: `evaluate-${task.id.slice(0, 8)}`,
      phase: PHASES.evaluate,
      promptName: 'evaluate',
      promptArgs: [
        context.trim() || '(no codebase context available)',
        task.title.trim(),
        (task.description ?? '').trim() || '(no description)',
      ],
      toolOverride: options.toolOverride ?? '',
      modelOverride: options.modelOverride ?? '',
      resolveErrorMessage:
        'no LLM tool available for evaluate phase — check config.defaultTool or orchestrator.phases.evaluate',
      exitErrorLabel: 'evaluate',
    },
    (output) => {
      const parsed = extractJSONObject<{
        needsBreakdown?: boolean;
        confidence?: number;
        reasoning?: string;
        suggestedSubtaskCount?: number;
      }>(output);

      if (!parsed) {
        throw new Error('failed to parse evaluation JSON from LLM output');
      }

      const needsBreakdown = Boolean(parsed.needsBreakdown);
      const confidence = Math.max(
        0,
        Math.min(1, Number(parsed.confidence ?? 0.5)),
      );
      return {
        complexity: needsBreakdown ? 'medium' : 'small',
        needsBreakdown: needsBreakdown,
        confidence,
        reasoning: String(parsed.reasoning ?? '').trim() || 'LLM evaluation',
        suggestedSubtaskCount: needsBreakdown
          ? Math.max(0, Number(parsed.suggestedSubtaskCount ?? 3))
          : 0,
        descriptionHash: hashDescription(task.title, task.description ?? ''),
      };
    },
    (evaluation) => ({
      qualityJson: JSON.stringify(evaluation),
    }),
  );

  return evaluation;
}

function hashDescription(title: string, description: string): string {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(`${title.trim()}\n${description.trim()}`);
  return hasher.digest('hex');
}
