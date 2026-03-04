import {
  collectAssistantText,
  formatTemplate,
  resolvePhaseExecution,
} from '../domain/llm';
import type { DriverRegistry } from '../driver/registry';
import { loadPrompt, type PromptName } from '../prompts/loader';
import type { InteractionStore } from '../store/interactions';
import type { Config } from '../types';
import type { WorkerRunResult } from '../worker/worker';
import { toErrorMessage } from './errors';

type Awaitable<T> = T | Promise<T>;

export interface PhaseDeps {
  config?: Config;
  registry?: DriverRegistry;
  repoDir: string;
  interactions?: InteractionStore;
  runTool: typeof import('../worker/worker').runTool;
}

export interface PhaseOpts {
  taskId: string | null;
  phase: string;
  promptName?: PromptName;
  promptArgs?: string[];
  prompt?: string;
  worktreePath?: string;
  extraContext?: string;
  timeoutMs?: number;
  toolOverride?: string;
  modelOverride?: string;
  resolvePhase?: string;
  interactionPhase?: string;
  taskRunId?: string;
  resolveErrorMessage?: string;
  exitErrorLabel?: string;
}

interface InteractionFinishFields {
  status: string;
  error?: string | null;
  diff?: string | null;
  exitCode?: number;
  durationMs?: number;
  qualityJson?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCost?: number;
  runId?: string | null;
  model?: string | null;
}

export interface PhaseRunContext {
  output: string;
  interactionId: string;
  tool: string;
  model: string;
  runResult: WorkerRunResult;
}

export interface PhaseRunResult<T> {
  result: T;
  interactionId: string;
  tool: string;
  model: string;
  output: string;
}

export async function createPhaseRunner(deps: PhaseDeps) {
  return async function runPhase<T>(
    opts: PhaseOpts,
    parse: (text: string, context: PhaseRunContext) => Awaitable<T>,
    onSuccess?: (
      result: T,
      context: PhaseRunContext,
    ) => Awaitable<Partial<InteractionFinishFields> | void>,
  ): Promise<PhaseRunResult<T>> {
    const phase = opts.phase.trim();
    const resolvePhase = opts.resolvePhase?.trim() || phase;
    const interactionPhase = opts.interactionPhase?.trim() || phase;
    const interactionTaskId = normalizeTaskID(opts.taskId);
    const worktreePath = opts.worktreePath?.trim() || deps.repoDir;
    const taskRunID = opts.taskRunId?.trim() || interactionTaskId || phase;

    const execution = resolvePhaseExecution({
      config: deps.config,
      registry: deps.registry,
      phase: resolvePhase,
      toolOverride: opts.toolOverride ?? '',
      modelOverride: opts.modelOverride ?? '',
    });
    if (!execution) {
      throw new Error(
        opts.resolveErrorMessage ?? `unable to resolve ${phase} tool/model`,
      );
    }

    const prompt = await loadPhasePrompt(deps.repoDir, opts);

    let interactionID = '';
    let interactionLogPath = '';
    if (deps.interactions) {
      const interaction = await deps.interactions.begin({
        taskId: interactionTaskId,
        phase: interactionPhase,
        tool: execution.toolName,
      });
      interactionID = interaction.id;
      interactionLogPath = interaction.logPath;
    }

    const finishInteraction = async (
      fields: InteractionFinishFields,
    ): Promise<void> => {
      if (!deps.interactions || !interactionID) return;
      await deps.interactions.finish(interactionID, fields);
    };

    try {
      const runResult = await deps.runTool({
        taskID: taskRunID,
        driverName: execution.toolName,
        driver: execution.driver,
        prompt,
        model: execution.model,
        dir: worktreePath,
        cwd: worktreePath,
        logsDir: `${deps.repoDir}/.orca/logs`,
        logPath: interactionLogPath || undefined,
        timeoutMS: opts.timeoutMs,
      });

      const output = collectAssistantText(runResult.events);
      if (runResult.exitCode !== 0) {
        const label = opts.exitErrorLabel?.trim() || phase;
        throw new Error(
          runResult.error ?? `${label} exited with code ${runResult.exitCode}`,
        );
      }

      const context: PhaseRunContext = {
        output,
        interactionId: interactionID,
        tool: execution.toolName,
        model: execution.model,
        runResult: runResult,
      };

      const parsed = await parse(output, context);
      const successFields = await onSuccess?.(parsed, context);

      await finishInteraction({
        status: 'completed',
        model: execution.model,
        inputTokens: runResult.inputTokens,
        outputTokens: runResult.outputTokens,
        estimatedCost: runResult.estimatedCost,
        exitCode: runResult.exitCode,
        durationMs: runResult.durationMS,
        ...successFields,
      });

      return {
        result: parsed,
        interactionId: interactionID,
        tool: execution.toolName,
        model: execution.model,
        output,
      };
    } catch (error) {
      await finishInteraction({
        status: 'failed',
        model: execution.model,
        error: toErrorMessage(error),
      });
      throw withInteractionID(error, interactionID);
    }
  };
}

function normalizeTaskID(taskId: string | null): string | null {
  if (typeof taskId !== 'string') return null;
  const normalized = taskId.trim();
  return normalized || null;
}

async function loadPhasePrompt(
  repoDir: string,
  opts: PhaseOpts,
): Promise<string> {
  const inlinePrompt = opts.prompt ?? '';
  const basePrompt = inlinePrompt
    ? inlinePrompt
    : formatTemplate(
        await loadPromptWithName(repoDir, opts.promptName),
        opts.promptArgs ?? [],
      );
  const extraContext = opts.extraContext ?? '';
  return extraContext ? `${basePrompt}${extraContext}` : basePrompt;
}

async function loadPromptWithName(
  repoDir: string,
  promptName?: PromptName,
): Promise<string> {
  if (!promptName) {
    throw new Error('promptName is required when prompt is not provided');
  }
  return loadPrompt(repoDir, promptName);
}

function withInteractionID(error: unknown, interactionID: string): unknown {
  if (!interactionID) return error;
  if (error && typeof error === 'object') {
    try {
      const value = error as { interactionId?: string };
      if (!value.interactionId?.trim()) {
        value.interactionId = interactionID;
      }
      return error;
    } catch {
      // Fall through to wrapped error.
    }
  }
  const wrapped = new Error(toErrorMessage(error));
  (wrapped as { interactionId?: string }).interactionId = interactionID;
  return wrapped;
}
