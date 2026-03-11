import type { EventSink } from '../api/ws';
import {
  buildMemoryContext,
  retrieveBudgetedMemory,
} from '../domain/memory-retrieval';
import { refreshMemoryEntries } from '../domain/memory-sync';
import { findTaskWorktree } from '../domain/worktree';
import type { PromptName } from '../prompts/loader';
import { loadPrompt } from '../prompts/loader';
import { createInteractionRunner } from '../shared/interaction-runner';
import { log } from '../shared/logger';
import * as configStore from '../store/config';
import * as taskStore from '../store/tasks';
import type { AppDeps } from '../types/deps';
import type { KnownWSEventType } from '../types/events';
import type { Job } from '../types/models';
import { runTool } from '../worker/worker';
import { assembleConsumedContext } from '../workflow/context';
import {
  completeStep,
  initWorkflow,
  joinPath,
  parsePath,
  resolveStepMeta,
  type WorkflowEngineDeps,
} from '../workflow/engine';
import type { AnyStateNode } from '../workflow/paths';
import { buildStepJsonSchema, getStateBranchNames } from '../workflow/schema';
import type { CompiledWorkflow, StepMeta } from '../workflow/types';
import { mergeTask } from '../workflows/merge';

type StepHandlerDeps = AppDeps & { sink: EventSink };

type StoppedError = Error & { taskId: string };

function stoppedError(taskId: string): StoppedError {
  const err = new Error(`task ${taskId} was stopped`) as StoppedError;
  err.name = 'StoppedError';
  err.taskId = taskId;
  return err;
}

function isStoppedError(err: unknown): err is StoppedError {
  return err instanceof Error && err.name === 'StoppedError';
}

function engineDeps(deps: StepHandlerDeps): WorkflowEngineDeps {
  return {
    db: deps.db,
    queue: deps.queue,
    workflowStore: deps.workflowStore,
  };
}

/**
 * Creates a job handler for a workflow step based on its executor type.
 * Routes: llm → interaction runner, agent → executor, shell → command, none → gate.
 */
export function createGenericStepHandler(
  stepName: string,
  deps: StepHandlerDeps,
): (job: Job) => Promise<Record<string, unknown> | void> {
  return async (job: Job) => {
    const taskId = job.taskId;
    if (!taskId) throw new Error(`job ${job.id} has no taskId`);

    const task = await taskStore.getTask(deps.db, taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);

    if (!task.workflow || !task.currentStep) {
      await initWorkflow(taskId, task.workflow ?? undefined, engineDeps(deps));
      await taskStore.updateTask(deps.db, undefined, taskId, {
        currentStep: stepName,
      });
    }

    const compiled = deps.workflowStore.resolve(task.workflow ?? undefined);
    let stepMeta: StepMeta;
    let stepNode: AnyStateNode;
    try {
      const resolved = resolveStepMeta(compiled.machine, stepName);
      stepMeta = resolved.meta;
      stepNode = resolved.stateNode;
    } catch {
      throw new Error(
        `step "${stepName}" not found in workflow "${compiled.name}"`,
      );
    }

    // Dependency gate: block at the configured step until all deps are met
    const dependencyGate = (
      compiled.machine.root as { meta?: { dependencyGate?: string } }
    ).meta?.dependencyGate;
    if (dependencyGate === stepName) {
      const depsMet = await taskStore.areDependenciesMet(deps.db, taskId);
      if (!depsMet) {
        log.info(`${stepName} skipped: dependencies not met (gate)`, {
          taskId,
        });
        return { taskId, skipped: true, reason: 'dependencies_not_met' };
      }
    }

    // Resolve consumes names to full dotted paths (scope-aware)
    const resolvedConsumes = stepMeta.consumes?.length
      ? stepMeta.consumes.map((s) => resolveConsumeName(s, stepName, compiled))
      : [];

    // Filter out code steps — tool runs in worktree and can git diff itself
    const consumesToUse = resolvedConsumes.filter((s) => {
      try {
        return resolveStepMeta(compiled.machine, s).meta.type !== 'code';
      } catch {
        return true;
      }
    });

    const consumedContext = consumesToUse.length
      ? await assembleConsumedContext({
          taskId,
          consumes: consumesToUse,
          interactionStore: deps.interactionStore,
        })
      : '';

    const payloadContext = job.payload?.context ?? '';
    const mergedContext = [consumedContext, payloadContext]
      .filter(Boolean)
      .join('\n\n---\n\n');

    const toolOverride = job.payload?.tool || stepMeta.tool || '';
    const modelOverride = job.payload?.model || stepMeta.model || '';
    const previousInteractionId = job.payload?.previousInteractionId || null;

    deps.sink.broadcast(`${stepName}.started` as KnownWSEventType, { taskId });

    try {
      let result: StepResult;

      if (stepMeta.type === 'merge') {
        result = await executeMergeStep(taskId, deps);
      } else if (stepMeta.executor === 'tool') {
        if (stepMeta.type === 'code') {
          result = await executeAgentStep(
            taskId,
            stepName,
            mergedContext,
            toolOverride,
            modelOverride,
            job,
            deps,
            previousInteractionId,
          );
        } else {
          result = await executeLLMStep(
            taskId,
            stepName,
            stepMeta,
            stepNode,
            mergedContext,
            toolOverride,
            modelOverride,
            job,
            deps,
            previousInteractionId,
          );
        }
      } else if (stepMeta.executor === 'shell') {
        result = await executeShellStep(taskId, stepName, stepMeta, deps);
      } else if (stepMeta.executor === 'none') {
        deps.sink.broadcast(`${stepName}.gated` as KnownWSEventType, {
          taskId,
        });
        return { taskId, gated: true };
      } else {
        throw new Error(
          `unknown executor "${stepMeta.executor}" for step "${stepName}"`,
        );
      }

      deps.sink.broadcast(`${stepName}.completed` as KnownWSEventType, {
        taskId,
        outcome: result.outcome,
        ...result.data,
      });

      await completeStep(taskId, result.outcome, engineDeps(deps), result.data);
      return { taskId, outcome: result.outcome, ...result.data };
    } catch (err) {
      if (isStoppedError(err)) {
        deps.sink.broadcast(`${stepName}.stopped` as KnownWSEventType, {
          taskId,
        });
        return { taskId, stopped: true };
      }
      const error = err instanceof Error ? err.message : String(err);
      deps.sink.broadcast(`${stepName}.failed` as KnownWSEventType, {
        taskId,
        error,
      });
      throw err;
    }
  };
}

interface StepResult {
  outcome: string;
  data?: Record<string, unknown>;
}

async function retrieveMemoryContext(
  taskId: string,
  deps: StepHandlerDeps,
): Promise<string> {
  try {
    const task = await taskStore.getTask(deps.db, taskId);
    if (!task) return '';
    const config = await configStore.loadConfig(deps.db);
    const memory = await retrieveBudgetedMemory(deps.memoryStore, deps.db, {
      taskId: task.id,
      title: task.title,
      description: task.description ?? '',
      syncer: {
        refresh: async (entryID: string) => {
          await refreshMemoryEntries(deps.repoDir, deps.memoryStore, entryID, {
            config,
            registry: deps.registry,
            interactions: deps.interactionStore,
          });
        },
      },
    });
    return buildMemoryContext(memory);
  } catch {
    return '';
  }
}

async function executeLLMStep(
  taskId: string,
  stepName: string,
  stepMeta: StepMeta,
  stepNode: AnyStateNode,
  consumedContext: string,
  toolOverride: string,
  modelOverride: string,
  job: Job,
  deps: StepHandlerDeps,
  previousInteractionId?: string | null,
): Promise<StepResult> {
  const config = await configStore.loadConfig(deps.db);
  const runInteraction = await createInteractionRunner({
    config,
    registry: deps.registry,
    repoDir: deps.repoDir,
    interactions: deps.interactionStore,
    runTool,
  });

  const task = await taskStore.getTask(deps.db, taskId);
  const promptName = stepMeta.prompt ?? stepName;

  const worktreePath = await findTaskWorktree(deps.repoDir, taskId);
  const memoryContext = await retrieveMemoryContext(taskId, deps);

  const feedback = job.payload?.feedback ?? '';
  const extraParts: string[] = [];

  if (stepMeta.type === 'context' || stepMeta.type === 'decision') {
    const outputStyle = await loadPrompt(deps.repoDir, 'outputStyle');
    if (outputStyle.trim()) extraParts.push(outputStyle.trim());
  }

  if (memoryContext) extraParts.push(memoryContext);
  if (consumedContext)
    extraParts.push(`## Context from prior steps\n${consumedContext}`);
  if (feedback) extraParts.push(`## Reviewer Feedback\n${feedback}`);

  const extraContext = extraParts.length
    ? `\n\n${extraParts.join('\n\n')}`
    : '';

  const branchNames = getStateBranchNames(stepNode);
  const jsonSchema = buildStepJsonSchema(stepMeta, branchNames);
  const workflowName = task?.workflow ?? 'standard';
  const pregenSchemaPath = deps.workflowStore.getSchemaPath(
    workflowName,
    stepName,
  );

  const { result, interactionId } = await runInteraction(
    {
      taskId,
      type: stepMeta.type ?? stepName,
      stepName,
      promptName: promptName as PromptName,
      promptArgs: [
        memoryContext || '(no retrieved context)',
        task?.title ?? '',
        task?.description ?? '',
      ],
      extraContext,
      worktreePath: worktreePath || undefined,
      toolOverride,
      modelOverride,
      resolveErrorMessage: `unable to resolve tool/model for step "${stepName}"`,
      exitErrorLabel: stepName,
      jsonSchema,
      schemaPath: pregenSchemaPath ?? undefined,
      previousInteractionId,
    },
    (output, ctx) => {
      const structured = ctx.runResult.structuredOutput;
      if (structured) {
        const resultKey =
          typeof structured.result === 'string' ? structured.result : '';
        const outputText =
          typeof structured.output === 'string' ? structured.output : output;

        if (resultKey && branchNames.includes(resultKey)) {
          return { outcome: resultKey, output: outputText };
        }
      }
      return parseStepOutcome(output, branchNames);
    },
    (parsed, ctx) => ({
      output: JSON.stringify({
        result: parsed.outcome,
        output: parsed.output,
      }),
      commitSha: ctx.runResult.commitSha || null,
    }),
  );

  return {
    outcome: result.outcome,
    data: { interactionId, output: result.output },
  };
}

/**
 * Parse structured outcome from LLM output.
 * Looks for JSON block with { result: "..." } or { outcome: "..." }.
 * Falls back to first valid branch name found in text, defaulting to first branch.
 */
export function parseStepOutcome(
  text: string,
  branchNamesOrStepDef: string[] | { branches?: Record<string, unknown> },
): { outcome: string; output: string } {
  const branchNames: string[] = Array.isArray(branchNamesOrStepDef)
    ? branchNamesOrStepDef
    : Object.keys(
        (branchNamesOrStepDef as { branches?: Record<string, unknown> })
          .branches ?? {},
      );

  // Try JSON extraction from fenced block
  const jsonMatch = text.match(/```json\s*\n([\s\S]*?)\n\s*```/);
  if (jsonMatch?.[1]) {
    try {
      const parsed = JSON.parse(jsonMatch[1]) as Record<string, unknown>;
      const resultKey =
        typeof parsed.result === 'string'
          ? parsed.result
          : typeof parsed.outcome === 'string'
            ? parsed.outcome
            : null;
      if (resultKey && branchNames.includes(resultKey)) {
        const outputText =
          typeof parsed.output === 'string'
            ? parsed.output
            : text.slice(0, text.lastIndexOf('```json')).trim() || text;
        return { outcome: resultKey, output: outputText };
      }
    } catch {
      // fall through
    }
  }

  // Try inline JSON with result or outcome key
  const inlineResult = text.match(
    /\{[^{}]*"(?:result|outcome)"\s*:\s*"([^"]+)"[^{}]*\}/,
  );
  if (inlineResult?.[1] && branchNames.includes(inlineResult[1])) {
    return { outcome: inlineResult[1], output: text };
  }

  // Keyword scan
  const lower = text.toLowerCase();
  for (const name of branchNames) {
    if (lower.includes(name.toLowerCase())) {
      return { outcome: name, output: text };
    }
  }

  return { outcome: branchNames[0] ?? 'success', output: text };
}

async function executeAgentStep(
  taskId: string,
  stepName: string,
  context: string,
  toolOverride: string,
  modelOverride: string,
  job: Job,
  deps: StepHandlerDeps,
  previousInteractionId?: string | null,
): Promise<StepResult> {
  const feedback = job.payload?.feedback ?? '';
  const resumeSessionID = await resolveResumeSessionID(
    taskId,
    stepName,
    job,
    deps,
  );

  const result = await deps.executor.runTaskByIDInternal(taskId, {
    toolOverride,
    modelOverride,
    context,
    resumeSessionID,
    feedback,
    interactionType: 'code',
    stepName,
    previousInteractionId,
  });

  if (result.status === 'stopped') {
    throw stoppedError(taskId);
  }

  const outcome =
    result.status === 'review' || result.status === 'merged'
      ? 'success'
      : 'fail';

  return {
    outcome,
    data: { status: result.status, taskID: result.taskID },
  };
}

async function resolveResumeSessionID(
  taskId: string,
  stepName: string,
  job: Job,
  deps: StepHandlerDeps,
): Promise<string | undefined> {
  const explicitResumeSessionID = (job.payload?.resumeSessionID ?? '').trim();
  if (explicitResumeSessionID) return explicitResumeSessionID;

  const feedback = (job.payload?.feedback ?? '').trim();
  if (!feedback) return undefined;

  const stepInteractions = await deps.interactionStore.listByStepName(
    taskId,
    stepName,
  );
  for (const interaction of stepInteractions) {
    const sessionId = interaction.sessionId?.trim();
    if (sessionId) return sessionId;
  }

  const latestSessionId =
    await deps.interactionStore.getLatestSessionId(taskId);
  return latestSessionId?.trim() || undefined;
}

async function executeMergeStep(
  taskId: string,
  deps: StepHandlerDeps,
): Promise<StepResult> {
  const result = await mergeTask(taskId, {
    repoDir: deps.repoDir,
    db: deps.db,
    interactions: deps.interactionStore,
    memoryStore: deps.memoryStore,
    registry: deps.registry,
    sink: deps.sink,
    queue: deps.queue,
    workflowStore: deps.workflowStore,
  });

  if (result.commitSha) {
    const existing = await deps.interactionStore.listByType(taskId, 'merge');
    const alreadyRecorded = existing.some(
      (ix) => ix.commitSha === result.commitSha,
    );
    if (!alreadyRecorded) {
      const ix = await deps.interactionStore.begin({
        taskId,
        type: 'merge',
        stepName: 'merge',
        tool: 'git',
      });
      await deps.interactionStore.finish(ix.id, {
        status: result.status === 'merged' ? 'completed' : 'failed',
        error: result.error ?? null,
        output: JSON.stringify({
          result: result.status === 'merged' ? 'success' : 'fail',
          data: {
            branch: result.branch,
            rebaseAttempted: result.rebaseAttempted,
            conflicts: result.conflicts,
          },
        }),
        commitSha: result.commitSha,
        exitCode: result.status === 'merged' ? 0 : 1,
        durationMs: 0,
        model: null,
      });
    }
  }

  return {
    outcome: result.status === 'merged' ? 'success' : 'fail',
    data: { status: result.status, error: result.error },
  };
}

async function executeShellStep(
  taskId: string,
  stepName: string,
  stepMeta: StepMeta,
  deps: StepHandlerDeps,
): Promise<StepResult> {
  const command = stepMeta.command ?? stepName;

  if (command === 'merge') {
    return executeMergeStep(taskId, deps);
  }

  log.warn('unknown shell command for step', { stepName, command });
  throw new Error(`unknown shell command "${command}" for step "${stepName}"`);
}

/**
 * Resolve a bare consume name to a full dotted path.
 * Checks siblings in current scope first, then walks up to parent scopes.
 */
export function resolveConsumeName(
  bareName: string,
  currentStepPath: string,
  compiled: CompiledWorkflow,
): string {
  if (bareName.includes('.')) return bareName;

  const segments = parsePath(currentStepPath);

  for (let depth = segments.length - 1; depth >= 1; depth--) {
    const scopePath = segments.slice(0, depth);
    const candidate = joinPath([...scopePath, bareName]);
    try {
      resolveStepMeta(compiled.machine, candidate);
      return candidate;
    } catch {
      // Not found in this scope, try parent
    }
  }

  return bareName;
}
