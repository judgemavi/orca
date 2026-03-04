import {
  ConflictDetector,
  type MonitorContext as ConflictMonitorContext,
} from '../domain/conflict-detector';
import { StuckDetector } from '../domain/stuck-detector';

export interface MonitorOptions {
  checkIntervalMS: number;
  conflictCheckIntervalMS: number;
  maxStuckCycles: number;
  repoDir: string;
  onStuck?: (taskID: string, message: string) => void;
  onConflict?: (taskIDs: string[], files: string[]) => void;
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
