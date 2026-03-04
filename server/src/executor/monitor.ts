import ms from 'ms';
import type { EventSink } from '../api/ws';
import {
  ConflictDetector,
  type MonitorContext as ConflictMonitorContext,
} from '../domain/conflict-detector';
import { StuckDetector } from '../domain/stuck-detector';
import type { Config } from '../types';

export interface MonitorOptions {
  checkIntervalMS: number;
  conflictCheckIntervalMS: number;
  maxStuckCycles: number;
  repoDir: string;
  onStuck?: (taskID: string, message: string) => void;
  onConflict?: (taskIDs: string[], files: string[]) => void;
}

export interface BatchMonitorOptions {
  monitor: Config['monitor'];
  repoDir: string;
  taskIDs: string[];
  eventSink?: EventSink;
  stopTask: (taskID: string) => void;
  context?: ConflictMonitorContext;
}

export class Monitor {
  private readonly taskIDs = new Set<string>();
  private readonly stuckDetector: StuckDetector;
  private readonly conflictDetector: ConflictDetector;
  private running = false;

  constructor(private readonly options: MonitorOptions) {
    this.stuckDetector = new StuckDetector({
      repoDir: this.options.repoDir,
      intervalMS: this.options.checkIntervalMS,
      maxCycles: this.options.maxStuckCycles,
      getTaskIDs: () => [...this.taskIDs],
      onStuck: (taskID, reason) => this.options.onStuck?.(taskID, reason),
    });

    this.conflictDetector = new ConflictDetector({
      repoDir: this.options.repoDir,
      intervalMS: this.options.conflictCheckIntervalMS,
      getTaskIDs: () => [...this.taskIDs],
      onConflict: (taskIDs, files) => this.options.onConflict?.(taskIDs, files),
    });
  }

  start(taskIDs: string[], ctx: ConflictMonitorContext = {}): void {
    for (const taskID of taskIDs) {
      const normalized = taskID.trim();
      if (!normalized) continue;
      this.taskIDs.add(normalized);
    }
    if (this.running) return;
    this.running = true;
    this.stuckDetector.start(ctx);
    this.conflictDetector.start(ctx);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.stuckDetector.stop();
    this.conflictDetector.stop();
    this.taskIDs.clear();
  }

  recordOutput(_taskID: string): void {
    // Stuck detection is based on worktree-diff progress.
  }

  finish(taskID: string): void {
    this.taskIDs.delete(taskID);
  }
}

export function startBatchMonitor(options: BatchMonitorOptions): Monitor {
  const interval = ms(options.monitor.stuckCheckInterval) ?? 60_000;
  const conflictInterval = ms(options.monitor.conflictCheckInterval) ?? 30_000;
  const maxCycles = Math.max(1, options.monitor.maxStuckCycles);

  const monitor = new Monitor({
    checkIntervalMS: interval,
    conflictCheckIntervalMS: conflictInterval,
    maxStuckCycles: maxCycles,
    repoDir: options.repoDir,
    onStuck: (taskID, message) => {
      console.warn('[monitor.stuck]', { taskID, message });
      options.eventSink?.broadcast('monitor.stuck', {
        taskId: taskID,
        message,
      });
      options.stopTask(taskID);
    },
    onConflict: (taskIDs, files) => {
      console.warn('[monitor.conflict]', { taskIDs, files });
      options.eventSink?.broadcast('monitor.conflict', {
        taskIds: taskIDs,
        files,
      });
    },
  });
  monitor.start(options.taskIDs, options.context ?? {});
  return monitor;
}
