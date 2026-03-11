import type { Config } from '../db/schema';
import {
  collectAssistantText,
  formatTemplate,
  resolveExecution,
} from '../domain/llm';
import type { ToolPluginRegistry } from '../plugin/registry';
import { loadPrompt, type PromptName } from '../prompts/loader';
import type { InteractionStore } from '../store/interactions';
import type { WorkerRunResult, runTool as RunToolFn } from '../worker/worker';
import { toErrorMessage } from './errors';
import { log } from './logger';

type Awaitable<T> = T | Promise<T>;

interface RunnerDeps {
  config?: Config;
  registry?: ToolPluginRegistry;
  repoDir: string;
  interactions?: InteractionStore;
  runTool: typeof RunToolFn;
}

interface RunnerOpts {
  taskId: string | null;
  type: string;
  stepName?: string;
  promptName?: PromptName;
  promptArgs?: string[];
  prompt?: string;
  worktreePath?: string;
  extraContext?: string;
  timeoutMs?: number;
  toolOverride?: string;
  modelOverride?: string;
  resolveErrorMessage?: string;
  exitErrorLabel?: string;
  jsonSchema?: Record<string, unknown>;
  schemaPath?: string;
  previousInteractionId?: string | null;
  resumeSessionID?: string;
  feedback?: string;
}

interface InteractionFinishFields {
  status: string;
  error?: string | null;
  output?: string | null;
  exitCode?: number;
  durationMs?: number;
  model?: string | null;
  commitSha?: string | null;
}

interface RunContext {
  output: string;
  interactionId: string;
  tool: string;
  model: string;
  runResult: WorkerRunResult;
}

interface RunResult<T> {
  result: T;
  interactionId: string;
  sessionId: string;
  tool: string;
  model: string;
  output: string;
}

export async function createInteractionRunner(deps: RunnerDeps) {
  return async function runInteraction<T>(
    opts: RunnerOpts,
    parse: (text: string, context: RunContext) => Awaitable<T>,
    onSuccess?: (
      result: T,
      context: RunContext,
    ) => Awaitable<Partial<InteractionFinishFields> | void>,
  ): Promise<RunResult<T>> {
    const type = opts.type.trim();
    const interactionTaskId = normalizeTaskID(opts.taskId);
    const worktreePath = opts.worktreePath?.trim() || deps.repoDir;
    const taskRunID = interactionTaskId ? `${type}-${interactionTaskId}` : type;

    const execution = resolveExecution({
      config: deps.config,
      registry: deps.registry,
      toolOverride: opts.toolOverride ?? '',
      modelOverride: opts.modelOverride ?? '',
    });
    if (!execution) {
      throw new Error(
        opts.resolveErrorMessage ?? `unable to resolve tool/model`,
      );
    }

    const prompt = await loadInteractionPrompt(deps.repoDir, opts);

    log.info('starting interaction', {
      type,
      taskId: interactionTaskId,
      tool: execution.toolName,
      model: execution.model,
    });

    let interactionID = '';
    let interactionLogPath = '';
    if (deps.interactions) {
      const interaction = await deps.interactions.begin({
        taskId: interactionTaskId,
        type,
        stepName: opts.stepName,
        tool: execution.toolName,
        previousInteractionId: opts.previousInteractionId ?? null,
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
        plugin: execution.plugin,
        prompt,
        model: execution.model,
        dir: worktreePath,
        cwd: worktreePath,
        logsDir: `${deps.repoDir}/.orca/logs`,
        logPath: interactionLogPath || undefined,
        timeoutMS: opts.timeoutMs,
        resumeSessionID: opts.resumeSessionID,
        feedback: opts.feedback,
        headlessOpts:
          opts.jsonSchema || opts.schemaPath
            ? { jsonSchema: opts.jsonSchema, schemaPath: opts.schemaPath }
            : undefined,
      });

      const output = collectAssistantText(runResult.events);
      if (runResult.exitCode !== 0) {
        const label = opts.exitErrorLabel?.trim() || type;
        throw new Error(
          runResult.error ?? `${label} exited with code ${runResult.exitCode}`,
        );
      }

      const context: RunContext = {
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
        exitCode: runResult.exitCode,
        durationMs: runResult.durationMS,
        ...successFields,
      });

      return {
        result: parsed,
        interactionId: interactionID,
        sessionId: runResult.sessionID,
        tool: execution.toolName,
        model: execution.model,
        output,
      };
    } catch (error) {
      log.error('interaction failed', {
        type,
        taskId: interactionTaskId,
        tool: execution.toolName,
        error: toErrorMessage(error),
      });
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

async function loadInteractionPrompt(
  repoDir: string,
  opts: RunnerOpts,
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
