import { JOB_PRIORITIES, type TaskStatus } from '@orca/types';
import type { TaskEntry } from '../db/schema';
import { getTask, listTasks } from '../store/tasks';
import {
  dedupeTaskIDs,
  ensureIntegrationBranch,
  prepareBatch,
  validateRunnableTaskStatuses,
} from './batch';
import { executeTaskRun } from './execute-task';
import type { ResultCoordinatorDeps } from './results';
import type { TaskRunResult } from './task-runner';
import type { ExecutorDeps, InternalRunOptions, RunOptions } from './types';
import { RUNNABLE_STATUSES } from './types';

export type { RunOptions } from './types';

export class Executor {
  private readonly runningControllers = new Map<string, AbortController>();
  private readonly stopRequested = new Set<string>();
  private readonly resultDeps: ResultCoordinatorDeps;

  constructor(private readonly deps: ExecutorDeps) {
    this.resultDeps = {
      db: deps.db,
      sink: deps.sink,
      interactionStore: deps.interactionStore,
      memoryStore: deps.memoryStore,
    };
  }

  async runPendingTasks(): Promise<void> {
    const pending = (await listTasks(this.deps.db))
      .filter((task) => RUNNABLE_STATUSES.has(task.status as TaskStatus))
      .map((task) => task.id);
    await this.runBatch(pending);
  }

  async runBatch(taskIDs: string[], options: RunOptions = {}): Promise<void> {
    const normalizedTaskIDs = dedupeTaskIDs(taskIDs);
    if (normalizedTaskIDs.length === 0) return;

    await validateRunnableTaskStatuses(this.deps, normalizedTaskIDs);
    await ensureIntegrationBranch(this.deps);
    await this.deps.memoryStore?.decayConfidence(7 * 24 * 3600 * 1000, 0.95);
    await prepareBatch(this.deps, normalizedTaskIDs);

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
      return enqueuedResult(taskID, 'code');
    }
    return this.runTaskByIDInternal(taskID, options);
  }

  async runSingleTask(
    task: TaskEntry,
  ): Promise<{ taskID: string; status: string }> {
    await this.runTaskByID(task.id);
    return { taskID: task.id, status: 'queued' };
  }

  async resumeTask(
    taskID: string,
    feedback = '',
    options: RunOptions = {},
  ): Promise<TaskRunResult> {
    const task = await getTask(this.deps.db, taskID);
    if (!task) {
      throw new Error(`task not found: ${taskID}`);
    }
    if (task.status !== 'stopped') {
      throw new Error(
        `task ${taskID} is "${task.status}", only stopped tasks can be resumed`,
      );
    }
    const sessionId =
      await this.deps.interactionStore?.getLatestSessionId(taskID);
    if (!sessionId?.trim()) {
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
      resumeSessionID: sessionId,
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
    return executeTaskRun({
      deps: this.deps,
      resultDeps: this.resultDeps,
      taskID,
      options,
      runtime: {
        consumeStop: (id) => this.consumeStop(id),
        registerController: (id, controller) => {
          this.runningControllers.set(id, controller);
        },
        releaseController: (id) => {
          this.runningControllers.delete(id);
        },
      },
    });
  }

  private consumeStop(taskID: string): boolean {
    if (!this.stopRequested.has(taskID)) return false;
    this.stopRequested.delete(taskID);
    return true;
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
    events: [],
    logPath: '',
    durationMS: 0,
    timedOut: false,
    aborted: false,
    diff: '',
    filesChanged: [],
  };
}
