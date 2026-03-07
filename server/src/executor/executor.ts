import type { EventSink } from '../api/ws';
import {
  buildMemoryContext,
  retrieveBudgetedMemory,
} from '../domain/memory-retrieval';
import {
  ensureIntegrationBranch as ensureIntegrationBranchDomain,
  ensureTaskWorktree as ensureTaskWorktreeDomain,
  findTaskWorktree,
} from '../domain/worktree';
import {
  buildMCPServerDef,
  ORCHESTRATOR_ALLOWED_TOOLS,
} from '../orchestrator/bootstrap';
import type { ToolPluginRegistry } from '../plugin/registry';
import type { JobQueue } from '../queue/queue';
import { toErrorMessage } from '../shared/errors';
import { gitRun } from '../shared/git';
import { genId } from '../shared/id';
import type { InteractionStore } from '../store/interactions';
import type { MemoryStore } from '../store/memory';
import type { TaskStore } from '../store/tasks';
import type { Config, Task, TaskStatus } from '../types';
import { JOB_PRIORITIES } from '../types';
import type { Monitor } from './monitor';
import { ResultCoordinator } from './results';
import {
  resolveTaskExecution,
  runTask,
  type TaskRunResult,
} from './task-runner';

interface ExecutorDeps {
  config: Config;
  registry: ToolPluginRegistry;
  taskStore: TaskStore;
  interactionStore?: InteractionStore;
  memoryStore?: MemoryStore;
  eventSink?: EventSink;
  repoDir: string;
  logsDir: string;
  queue?: JobQueue;
}

export interface RunOptions {
  toolOverride?: string;
  modelOverride?: string;
  context?: string;
}

interface InternalRunOptions extends RunOptions {
  runID: string;
  resumeSessionID?: string;
  feedback?: string;
  monitor?: Monitor;
}

interface ResumeContext {
  interactionType: string;
  resumeSessionID: string;
  feedback: string;
  reviewID: string;
}

const RUNNABLE_STATUSES = new Set<TaskStatus>([
  'pending',
  'planned',
  'failed',
  'review',
]);

export class Executor {
  private readonly runningControllers = new Map<string, AbortController>();
  private readonly stopRequested = new Set<string>();
  private readonly resultCoordinator: ResultCoordinator;

  constructor(private readonly deps: ExecutorDeps) {
    this.resultCoordinator = new ResultCoordinator({
      taskStore: deps.taskStore,
      interactionStore: deps.interactionStore,
      memoryStore: deps.memoryStore,
      eventSink: deps.eventSink,
    });
  }

  async runPendingTasks(): Promise<void> {
    const pending = (await this.deps.taskStore.list())
      .filter((task) => RUNNABLE_STATUSES.has(task.status))
      .map((task) => task.id);
    await this.runBatch(pending);
  }

  async runBatch(taskIDs: string[], options: RunOptions = {}): Promise<void> {
    const normalizedTaskIDs = dedupe(taskIDs);
    if (normalizedTaskIDs.length === 0) return;

    await this.validateRunnableTaskStatuses(normalizedTaskIDs);
    await this.ensureIntegrationBranch();
    await this.deps.memoryStore?.decayConfidence(7 * 24 * 3600 * 1000, 0.95);
    await this.prepareBatch(normalizedTaskIDs);

    for (const taskID of normalizedTaskIDs) {
      await this.deps.queue!.enqueue({
        type: 'code',
        taskId: taskID,
        priority: JOB_PRIORITIES.code,
        payload: {
          tool: options.toolOverride ?? '',
          model: options.modelOverride ?? '',
          context: options.context ?? '',
        },
      });
    }
  }

  async runTaskByID(
    taskID: string,
    options: RunOptions = {},
  ): Promise<TaskRunResult> {
    if (this.deps.queue) {
      await this.deps.queue.enqueue({
        type: 'code',
        taskId: taskID,
        priority: JOB_PRIORITIES.code,
        payload: {
          tool: options.toolOverride ?? '',
          model: options.modelOverride ?? '',
          context: options.context ?? '',
        },
      });
      // Actual result delivered via WS events/job completion
      return enqueuedResult(taskID, 'code');
    }
    return this.runTaskByIDInternal(taskID, {
      ...options,
      runID: genId(),
    });
  }

  async runSingleTask(task: Task): Promise<{ taskID: string; status: string }> {
    await this.runTaskByID(task.id);
    return { taskID: task.id, status: 'queued' };
  }

  async resumeTask(
    taskID: string,
    feedback = '',
    options: RunOptions = {},
  ): Promise<TaskRunResult> {
    const task = await this.deps.taskStore.get(taskID);
    if (!task) {
      throw new Error(`task not found: ${taskID}`);
    }
    if (task.status !== 'stopped') {
      throw new Error(
        `task ${taskID} is "${task.status}", only stopped tasks can be resumed`,
      );
    }
    if (!task.sessionId?.trim()) {
      throw new Error(`task ${taskID} cannot resume without sessionId`);
    }

    if (this.deps.queue) {
      await this.deps.queue.enqueue({
        type: 'code',
        taskId: taskID,
        priority: JOB_PRIORITIES.code,
        payload: {
          tool: options.toolOverride ?? '',
          model: options.modelOverride ?? '',
          context: options.context ?? '',
          feedback,
        },
      });
      return enqueuedResult(taskID, 'revise');
    }

    return this.runTaskByIDInternal(taskID, {
      ...options,
      runID: genId(),
      resumeSessionID: task.sessionId,
      feedback,
    });
  }

  stopAllTasks(): string[] {
    const stopped = [...this.runningControllers.keys()];
    for (const taskID of stopped) this.stopTask(taskID);
    return stopped;
  }

  stopTask(taskID: string): boolean {
    const controller = this.runningControllers.get(taskID);
    if (!controller) return false;

    this.stopRequested.add(taskID);
    controller.abort('task stopped');
    return true;
  }

  async runTaskByIDInternal(
    taskID: string,
    options: InternalRunOptions,
  ): Promise<TaskRunResult> {
    const task = await this.deps.taskStore.get(taskID);
    if (!task) {
      throw new Error(`task not found: ${taskID}`);
    }
    if (
      !options.resumeSessionID?.trim() &&
      !RUNNABLE_STATUSES.has(task.status)
    ) {
      throw new Error(
        `task ${taskID} is ${task.status}; runnable statuses are: pending, planned, failed, review`,
      );
    }

    const resume = await this.resolveResumeContext(task, options);

    const execution = resolveTaskExecution(
      this.deps.config,
      this.deps.registry,
      options.toolOverride ?? '',
      options.modelOverride ?? '',
      resume.interactionType,
    );

    if (resume.interactionType === 'revise') {
      await this.deps.interactionStore?.supersedeReviewInteractions(task.id);
    }

    let interactionID = '';
    let interactionLogPath = '';
    if (this.deps.interactionStore) {
      const interaction = await this.deps.interactionStore.begin({
        taskId: task.id,
        type: resume.interactionType,
        tool: execution.toolName,
      });
      interactionID = interaction.id;
      interactionLogPath = interaction.logPath;
    }

    await this.deps.taskStore.updateStatus(task.id, 'running');

    const controller = new AbortController();
    this.runningControllers.set(task.id, controller);

    let worktreePath = '';
    let memoryContext = '';
    let usedMemoryIDs: string[] = [];
    let usedProvenanceHashes: string[] = [];
    if (this.deps.memoryStore && this.deps.taskStore) {
      try {
        const memResult = await this.buildTaskContextSection(
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
      worktreePath = await this.ensureTaskWorktree(task);
      const mcpServer = buildMCPServerDef(this.deps.repoDir);

      const result = await runTask({
        taskID: task.id,
        interactionType: resume.interactionType,
        title: task.title,
        description: task.description ?? '',
        plan: task.plan ?? '',
        context: mergedContext,
        cwd: worktreePath,
        worktreePath,
        logsDir: this.deps.logsDir,
        repoDir: this.deps.repoDir,
        baseBranch: this.deps.config.project.integrationBranch,
        toolName: execution.toolName,
        plugin: execution.plugin,
        model: execution.model,
        interactionLogPath,
        resumeSessionID: resume.resumeSessionID,
        feedback: resume.feedback,
        headlessOpts: {
          mcpServer,
          allowedTools: ORCHESTRATOR_ALLOWED_TOOLS,
        },
        signal: controller.signal,
        onOutputLine: () => {
          options.monitor?.recordOutput(task.id);
        },
      });

      const finalized = this.resultCoordinator.applyStopOverride(
        task.id,
        result,
        (id) => this.consumeStop(id),
      );

      await this.resultCoordinator.persistSuccess({
        taskID: task.id,
        interactionID,
        runID: options.runID,
        model: execution.model,
        reviewID: resume.reviewID,
        result: finalized,
        memoryMeta: {
          usedMemoryIds: usedMemoryIDs,
          usedProvenanceHashes: usedProvenanceHashes,
        },
      });
      return finalized;
    } catch (error) {
      const stopRequested = this.consumeStop(task.id);
      const status: TaskStatus = stopRequested ? 'stopped' : 'failed';
      const failedResult = this.resultCoordinator.buildFailedResult({
        taskID: task.id,
        interactionType: resume.interactionType,
        toolName: execution.toolName,
        model: execution.model,
        status,
        aborted: stopRequested,
        error: toErrorMessage(error),
        logPath:
          interactionLogPath ||
          `${this.deps.logsDir}/${task.id}.${Date.now()}.log`,
      });

      await this.resultCoordinator.persistFailure({
        taskID: task.id,
        interactionID,
        runID: options.runID,
        model: execution.model,
        result: failedResult,
      });

      return failedResult;
    } finally {
      this.runningControllers.delete(task.id);
      options.monitor?.finish(task.id);
    }
  }

  private async resolveResumeContext(
    task: Task,
    options: InternalRunOptions,
  ): Promise<ResumeContext> {
    const pendingReview = await this.deps.taskStore.getPendingReview(task.id);

    const resumeSessionID =
      options.resumeSessionID?.trim() ||
      (task.status === 'stopped' ? (task.sessionId ?? '').trim() : '');

    const feedback =
      (options.feedback ?? '').trim() || pendingReview?.feedback?.trim() || '';
    const interactionType = resumeSessionID || feedback ? 'revise' : 'code';

    return {
      interactionType,
      resumeSessionID,
      feedback,
      reviewID: pendingReview?.id ?? '',
    };
  }

  private consumeStop(taskID: string): boolean {
    if (!this.stopRequested.has(taskID)) return false;
    this.stopRequested.delete(taskID);
    return true;
  }

  private async buildTaskContextSection(
    taskID: string,
    title: string,
    description: string,
  ): Promise<{
    context: string;
    usedMemoryIDs: string[];
    usedProvenanceHashes: string[];
  }> {
    const result = await retrieveBudgetedMemory(
      this.deps.memoryStore!,
      this.deps.taskStore,
      {
        taskId: taskID,
        title,
        description,
      },
    );
    const context = buildMemoryContext(result);

    const usedMemoryIDs: string[] = [];
    const usedProvenanceHashes: string[] = [];
    const allEntries = [
      ...(result.summary ? [result.summary] : []),
      ...result.exactMatches,
      ...result.semanticMatches,
      ...result.recencyMatches,
    ];
    for (const entry of allEntries) {
      usedMemoryIDs.push(entry.id);
      if (entry.provenanceHash) {
        usedProvenanceHashes.push(entry.provenanceHash);
      }
    }

    return { context, usedMemoryIDs, usedProvenanceHashes };
  }

  private async ensureIntegrationBranch(): Promise<void> {
    await ensureIntegrationBranchDomain(
      this.deps.repoDir,
      this.deps.config.project.integrationBranch,
    );
  }

  private async ensureTaskWorktree(task: Task): Promise<string> {
    return ensureTaskWorktreeDomain({
      repoDir: this.deps.repoDir,
      worktreeDir: this.deps.config.project.worktreeDir,
      integrationBranch: this.deps.config.project.integrationBranch,
      task,
    });
  }

  private async validateRunnableTaskStatuses(taskIDs: string[]): Promise<void> {
    for (const taskID of taskIDs) {
      const task = await this.deps.taskStore.get(taskID);
      if (!task) {
        throw new Error(`task not found: ${taskID}`);
      }
      if (!RUNNABLE_STATUSES.has(task.status)) {
        throw new Error(
          `task ${taskID} is ${task.status}; runnable statuses are: pending, planned, failed, review`,
        );
      }
    }
  }

  private async prepareBatch(taskIDs: string[]): Promise<void> {
    const preparedTaskIDs: string[] = [];
    for (const taskID of taskIDs) {
      const task = await this.deps.taskStore.get(taskID);
      if (!task) {
        await this.rollbackPreparation(preparedTaskIDs);
        throw new Error(`failed to prepare task ${taskID}: task not found`);
      }

      try {
        const existing = await findTaskWorktree(this.deps.repoDir, taskID);
        if (existing) continue;
        await this.ensureTaskWorktree(task);
        preparedTaskIDs.push(taskID);
      } catch (error) {
        await this.rollbackPreparation(preparedTaskIDs);
        throw new Error(
          `failed to prepare task ${taskID}: ${toErrorMessage(error)}`,
        );
      }
    }
  }

  private async rollbackPreparation(taskIDs: string[]): Promise<void> {
    for (const taskID of taskIDs) {
      await this.removeTaskWorktree(taskID).catch(() => {});
      try {
        await this.deps.taskStore.updateStatus(taskID, 'planned');
      } catch {
        // Ignore reset failures during rollback.
      }
    }
  }

  private async removeTaskWorktree(taskID: string): Promise<void> {
    const worktreePath = await findTaskWorktree(
      this.deps.repoDir,
      taskID,
    ).catch(() => '');
    if (!worktreePath) return;
    await gitRun(this.deps.repoDir, [
      'worktree',
      'remove',
      '--force',
      worktreePath,
    ]);
    const branches = await gitRun(this.deps.repoDir, [
      'for-each-ref',
      '--format=%(refname:short)',
      `refs/heads/orca/task-${taskID}*`,
    ]);
    if (branches.exitCode !== 0) return;
    const branchNames = branches.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    for (const branch of branchNames) {
      await gitRun(this.deps.repoDir, ['branch', '-D', branch]);
    }
  }
}

function enqueuedResult(
  taskID: string,
  interactionType: string,
): TaskRunResult {
  return {
    taskID,
    interactionType,
    toolName: '',
    model: '',
    status: 'running',
    interactionStatus: 'completed',
    exitCode: 0,
    signalCode: null,
    sessionID: '',
    inputTokens: 0,
    outputTokens: 0,
    estimatedCost: 0,
    events: [],
    logPath: '',
    durationMS: 0,
    timedOut: false,
    aborted: false,
    diff: '',
    filesChanged: [],
  };
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const value of values) {
    const normalized = value.trim();
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }

  return out;
}
