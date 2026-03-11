import type { TaskStatus } from '@orca/types';
import type { TaskEntry } from '../db/schema';
import { ORCHESTRATOR_ALLOWED_TOOLS } from '../orchestrator/bootstrap';
import { toErrorMessage } from '../shared/errors';
import { getTask, updateTask } from '../store/tasks';
import { ensureTaskWorktree } from './batch';
import { buildTaskContextSection } from './context';
import {
  applyStopOverride,
  buildFailedResult,
  persistFailure,
  persistSuccess,
  type ResultCoordinatorDeps,
} from './results';
import {
  resolveTaskExecution,
  runTask,
  type TaskRunResult,
} from './task-runner';
import type {
  ExecutorDeps,
  InternalRunOptions,
  ResumeContext,
  RuntimeControl,
} from './types';
import { RUNNABLE_STATUSES } from './types';

export async function executeTaskRun(input: {
  deps: ExecutorDeps;
  resultDeps: ResultCoordinatorDeps;
  taskID: string;
  options: InternalRunOptions;
  runtime: RuntimeControl;
}): Promise<TaskRunResult> {
  const { deps, resultDeps, taskID, options, runtime } = input;
  const task = await getTask(deps.db, taskID);
  if (!task) {
    throw new Error(`task not found: ${taskID}`);
  }
  if (
    !options.resumeSessionID?.trim() &&
    !RUNNABLE_STATUSES.has(task.status as TaskStatus)
  ) {
    throw new Error(
      `task ${taskID} is ${task.status}; runnable statuses are: pending, planned, failed, review`,
    );
  }

  const resume = await resolveResumeContext(deps, task, options);
  const execution = resolveTaskExecution(
    deps.config,
    deps.registry,
    options.toolOverride ?? '',
    options.modelOverride ?? '',
  );

  if (resume.interactionType === 'revise') {
    await deps.interactionStore?.supersedeReviewInteractions(task.id);
  }

  let interactionID = '';
  let interactionLogPath = '';
  if (deps.interactionStore) {
    const interaction = await deps.interactionStore.begin({
      taskId: task.id,
      type: resume.interactionType,
      stepName: options.stepName,
      tool: execution.toolName,
      previousInteractionId: options.previousInteractionId ?? null,
    });
    interactionID = interaction.id;
    interactionLogPath = interaction.logPath;
  }

  await updateTask(deps.db, deps.sink, task.id, { status: 'running' });

  const controller = new AbortController();
  runtime.registerController(task.id, controller);

  let memoryContext = '';
  let usedMemoryIDs: string[] = [];
  let usedProvenanceHashes: string[] = [];
  if (deps.memoryStore) {
    try {
      const memResult = await buildTaskContextSection(
        deps.memoryStore,
        deps.db,
        task.id,
        task.title,
        task.description ?? '',
      );
      memoryContext = memResult.context;
      usedMemoryIDs = memResult.usedMemoryIDs;
      usedProvenanceHashes = memResult.usedProvenanceHashes;
    } catch {
      // Memory retrieval failure should not block execution.
    }
  }

  const mergedContext = [memoryContext, options.context ?? '']
    .filter(Boolean)
    .join('\n\n')
    .trim();

  try {
    const worktreePath = await ensureTaskWorktree(deps, task);

    const result = await runTask({
      taskID: task.id,
      interactionType: resume.interactionType,
      title: task.title,
      description: task.description ?? '',
      context: mergedContext,
      cwd: worktreePath,
      worktreePath,
      logsDir: deps.logsDir,
      repoDir: deps.repoDir,
      baseBranch: deps.config.project.integrationBranch,
      toolName: execution.toolName,
      plugin: execution.plugin,
      model: execution.model,
      interactionLogPath,
      resumeSessionID: resume.resumeSessionID,
      feedback: resume.feedback,
      headlessOpts: {
        allowedTools: ORCHESTRATOR_ALLOWED_TOOLS,
      },
      signal: controller.signal,
      onOutputLine: () => {
        options.monitor?.recordOutput(task.id);
      },
    });

    const finalized = applyStopOverride(task.id, result, (id) =>
      runtime.consumeStop(id),
    );

    await persistSuccess(resultDeps, {
      taskID: task.id,
      interactionID,
      model: execution.model,
      result: finalized,
      memoryMeta: {
        usedMemoryIds: usedMemoryIDs,
        usedProvenanceHashes,
      },
    });

    return finalized;
  } catch (error) {
    const stopRequested = runtime.consumeStop(task.id);
    const status: TaskStatus = stopRequested ? 'stopped' : 'failed';
    const failedResult = buildFailedResult({
      taskID: task.id,
      interactionType: resume.interactionType,
      toolName: execution.toolName,
      model: execution.model,
      status,
      aborted: stopRequested,
      error: toErrorMessage(error),
      logPath:
        interactionLogPath || `${deps.logsDir}/${task.id}.${Date.now()}.log`,
    });

    await persistFailure(resultDeps, {
      taskID: task.id,
      interactionID,
      model: execution.model,
      result: failedResult,
    });

    return failedResult;
  } finally {
    runtime.releaseController(task.id);
    options.monitor?.finish(task.id);
  }
}

async function resolveResumeContext(
  deps: Pick<ExecutorDeps, 'interactionStore'>,
  task: TaskEntry,
  options: InternalRunOptions,
): Promise<ResumeContext> {
  const storedSessionId =
    task.status === 'stopped'
      ? ((await deps.interactionStore?.getLatestSessionId(task.id)) ?? '')
      : '';
  const resumeSessionID =
    options.resumeSessionID?.trim() || storedSessionId.trim();

  const feedback = (options.feedback ?? '').trim();
  const interactionType =
    options.interactionType ??
    (resumeSessionID || feedback ? 'revise' : 'code');

  return {
    interactionType,
    resumeSessionID,
    feedback,
  };
}
