import type { Config } from '../db/schema';
import type { ToolPluginRegistry } from '../plugin/registry';
import { camelizeKeys } from '../shared/camelize';
import { createInteractionRunner } from '../shared/interaction-runner';
import type { InteractionStore } from '../store/interactions';
import type { TaskEvaluation } from '../types/api';
import type { Task } from '../types/models';
import { runTool } from '../worker/worker';
import { evaluateSchema } from '../workflow/schema';
import type { WorkflowStore } from '../workflow/store';
import { readExploreContext } from './explore';
import { extractJSONObject } from './llm';

interface EvaluateOptions {
  repoDir: string;
  config?: Config;
  registry?: ToolPluginRegistry;
  interactions?: InteractionStore;
  workflowStore?: WorkflowStore;
  toolOverride?: string;
  modelOverride?: string;
  resumeSessionID?: string;
  feedback?: string;
}

interface EvaluateResult {
  evaluation: TaskEvaluation;
  sessionId: string;
}

export async function evaluateTask(
  task: Pick<Task, 'id' | 'title' | 'description'>,
  options: EvaluateOptions,
): Promise<EvaluateResult> {
  const context = await readExploreContext(options.repoDir);
  const runInteraction = await createInteractionRunner({
    config: options.config,
    registry: options.registry,
    repoDir: options.repoDir,
    interactions: options.interactions,
    runTool,
  });
  const schemaPath =
    options.workflowStore?.getSystemSchemaPath('evaluate') ?? undefined;

  const { result: evaluation, sessionId } = await runInteraction(
    {
      taskId: task.id,
      type: 'evaluate',
      promptName: 'evaluate',
      promptArgs: [
        context.trim() || '(no codebase context available)',
        task.title.trim(),
        (task.description ?? '').trim() || '(no description)',
      ],
      toolOverride: options.toolOverride ?? '',
      modelOverride: options.modelOverride ?? '',
      resumeSessionID: options.resumeSessionID,
      feedback: options.feedback,
      resolveErrorMessage:
        'no LLM tool available — check config.tools and orchestrator settings',
      exitErrorLabel: 'evaluate',
      jsonSchema: evaluateSchema,
      schemaPath,
    },
    (output, ctx) => {
      // Prefer structured output from CLI-native JSON schema.
      // Camelize keys: structuredOutput may have snake_case keys from raw JSON.
      const structured = ctx.runResult.structuredOutput
        ? (camelizeKeys(ctx.runResult.structuredOutput) as {
            needsBreakdown?: boolean;
            confidence?: number;
            reasoning?: string;
            suggestedSubtaskCount?: number;
            needsUserInput?: boolean;
            userInputQuestion?: string;
          })
        : undefined;
      const parsed =
        structured ??
        extractJSONObject<{
          needsBreakdown?: boolean;
          confidence?: number;
          reasoning?: string;
          suggestedSubtaskCount?: number;
          needsUserInput?: boolean;
          userInputQuestion?: string;
        }>(output);

      if (!parsed) {
        throw new Error('failed to parse evaluation JSON from LLM output');
      }

      const needsBreakdown = Boolean(parsed.needsBreakdown);
      const needsUserInput = Boolean(parsed.needsUserInput);
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
        needsUserInput,
        userInputQuestion: needsUserInput
          ? String(parsed.userInputQuestion ?? '').trim()
          : undefined,
      };
    },
    (evaluation) => ({
      output: JSON.stringify({
        result: evaluation.needsBreakdown ? 'needs_breakdown' : 'ready',
        data: evaluation,
      }),
    }),
  );

  return { evaluation, sessionId };
}

function hashDescription(title: string, description: string): string {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(`${title.trim()}\n${description.trim()}`);
  return hasher.digest('hex');
}
