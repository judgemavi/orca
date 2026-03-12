import { resolveStepJob } from '../workflows/tasks';
import { executeTaskRun } from './execute-task';
import type { ResultCoordinatorDeps } from './results';
import type { TaskRunResult } from './task-runner';
import type { ExecutorDeps, InternalRunOptions, RunOptions } from './types';

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

  async resumeTask(
    taskID: string,
    feedback = '',
    options: RunOptions = {},
  ): Promise<TaskRunResult> {
    if (this.deps.queue) {
      const { type, priority } = await resolveStepJob(
        this.deps.db,
        taskID,
        this.deps.workflowStore,
      );
      await this.deps.queue.enqueue({
        type,
        taskId: taskID,
        priority,
        payload: {
          tool: options.toolOverride ?? '',
          model: options.modelOverride ?? '',
          context: options.context ?? '',
          feedback,
        },
      });
      return enqueuedResult(taskID, type);
    }

    const sessionId =
      await this.deps.interactionStore?.getLatestSessionId(taskID);
    return this.runTaskByIDInternal(taskID, {
      ...options,
      resumeSessionID: sessionId?.trim() || undefined,
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
