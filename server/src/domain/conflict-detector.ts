import { gitRun } from '../shared/git';
import type { MonitorContext } from './runtime-monitor';
import {
  dedupeNormalizedStrings,
  PollingMonitor,
  type RuntimeMonitor,
} from './runtime-monitor';
import { findTaskWorktree } from './worktree';

interface ConflictDetectionResult {
  taskIds: string[];
  files: string[];
}

interface ConflictDetectorOptions {
  repoDir: string;
  intervalMS?: number;
  getTaskIDs: () => string[];
  onConflict?: (taskIDs: string[], files: string[]) => void;
}

export class ConflictDetector implements RuntimeMonitor {
  private readonly fired = new Set<string>();
  private readonly runtime: PollingMonitor;

  constructor(private readonly options: ConflictDetectorOptions) {
    this.runtime = new PollingMonitor({
      intervalMS: this.options.intervalMS ?? 30_000,
      onStop: () => this.fired.clear(),
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
    const fileOwners = new Map<string, Set<string>>();
    const taskIDs = dedupeNormalizedStrings(this.options.getTaskIDs());
    for (const taskID of taskIDs) {
      const files = await changedFiles(this.options.repoDir, taskID).catch(
        () => [],
      );
      if (files.length === 0) continue;
      for (const file of files) {
        if (!fileOwners.has(file)) fileOwners.set(file, new Set());
        fileOwners.get(file)?.add(taskID);
      }
    }

    for (const group of buildConflictGroups(fileOwners)) {
      const key = `${group.taskIds.join(',')}::${group.files.join(',')}`;
      if (this.fired.has(key)) continue;
      this.fired.add(key);
      this.options.onConflict?.(group.taskIds, group.files);
    }
  }
}

function buildConflictGroups(
  fileOwners: Map<string, Set<string>>,
): ConflictDetectionResult[] {
  const grouped = new Map<string, ConflictDetectionResult>();

  for (const [file, owners] of fileOwners.entries()) {
    if (owners.size < 2) continue;
    const taskIDs = [...owners].sort((a, b) => a.localeCompare(b));
    const key = taskIDs.join('|');
    if (!grouped.has(key)) {
      grouped.set(key, { taskIds: taskIDs, files: [] });
    }
    grouped.get(key)?.files.push(file);
  }

  return [...grouped.values()].map((group) => ({
    taskIds: group.taskIds,
    files: [...group.files].sort((a, b) => a.localeCompare(b)),
  }));
}

async function changedFiles(
  repoDir: string,
  taskID: string,
): Promise<string[]> {
  const worktreePath = await findTaskWorktree(repoDir, taskID);
  if (!worktreePath) return [];

  const result = await gitRun(worktreePath, ['diff', '--name-only', 'HEAD']);
  if (result.exitCode !== 0) return [];
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}
