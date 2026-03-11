import { createHash } from 'node:crypto';
import { gitRun } from '../shared/git';
import type { MonitorContext } from './runtime-monitor';
import {
  dedupeNormalizedStrings,
  PollingMonitor,
  type RuntimeMonitor,
} from './runtime-monitor';
import { findTaskWorktree } from './worktree';

interface StuckDetectorOptions {
  repoDir: string;
  intervalMS?: number;
  maxCycles?: number;
  getTaskIDs: () => string[];
  onStuck?: (taskID: string, reason: string) => void;
}

interface TaskState {
  lastHash: string;
  noProgress: number;
  history: string[];
}

export class StuckDetector implements RuntimeMonitor {
  private readonly states = new Map<string, TaskState>();
  private readonly runtime: PollingMonitor;

  constructor(private readonly options: StuckDetectorOptions) {
    this.runtime = new PollingMonitor({
      intervalMS: this.options.intervalMS ?? 60_000,
      onStop: () => this.states.clear(),
      tick: () => this.tick(),
    });
  }

  start(ctx: MonitorContext = {}): void {
    this.runtime.start(ctx);
  }

  stop(): void {
    this.runtime.stop();
  }

  private async tick(): Promise<void> {
    const taskIDs = dedupeNormalizedStrings(this.options.getTaskIDs());
    const active = new Set(taskIDs);
    for (const tracked of this.states.keys()) {
      if (!active.has(tracked)) {
        this.states.delete(tracked);
      }
    }

    const maxCycles = Math.max(1, this.options.maxCycles ?? 3);
    for (const taskID of taskIDs) {
      const currentHash = await diffHash(this.options.repoDir, taskID).catch(
        () => '',
      );
      if (!currentHash) continue;

      const state = this.states.get(taskID) ?? {
        lastHash: '',
        noProgress: 0,
        history: [],
      };

      if (!state.lastHash) {
        state.lastHash = currentHash;
        state.history.push(currentHash);
        this.states.set(taskID, state);
        continue;
      }

      if (state.lastHash === currentHash) {
        state.noProgress += 1;
        if (state.noProgress >= maxCycles) {
          this.options.onStuck?.(taskID, 'no progress');
          state.noProgress = 0;
        }
      } else {
        state.noProgress = 0;
        if (state.history.includes(currentHash)) {
          this.options.onStuck?.(taskID, 'edit-revert cycle');
        }
      }

      state.lastHash = currentHash;
      state.history.push(currentHash);
      if (state.history.length > 6) {
        state.history.shift();
      }
      this.states.set(taskID, state);
    }
  }
}

async function diffHash(repoDir: string, taskID: string): Promise<string> {
  const worktreePath = await findTaskWorktree(repoDir, taskID);
  if (!worktreePath) return '';

  const result = await gitRun(worktreePath, ['diff', '--stat', 'HEAD']);
  if (result.exitCode !== 0) return '';
  return createHash('sha256').update(result.stdout).digest('hex');
}
