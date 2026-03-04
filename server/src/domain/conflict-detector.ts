import { findTaskWorktree } from './worktree'
import { gitRun } from '../shared/git'

export interface ConflictDetectionResult {
  taskIds: string[]
  files: string[]
}

export interface ConflictDetectorOptions {
  repoDir: string
  intervalMS?: number
  getTaskIDs: () => string[]
  onConflict?: (taskIDs: string[], files: string[]) => void
}

export interface MonitorContext {
  signal?: AbortSignal
}

export interface RuntimeMonitor {
  start(ctx?: MonitorContext): void
  stop(): void
}

export class ConflictDetector implements RuntimeMonitor {
  private readonly fired = new Set<string>()
  private timer: ReturnType<typeof setInterval> | null = null
  private tickInFlight = false
  private abortListener: (() => void) | null = null

  constructor(private readonly options: ConflictDetectorOptions) {}

  start(ctx: MonitorContext = {}): void {
    if (this.timer) return
    const interval = Math.max(1_000, this.options.intervalMS ?? 30_000)
    this.timer = setInterval(() => {
      void this.tick()
    }, interval)
    if (ctx.signal) {
      const onAbort = () => this.stop()
      ctx.signal.addEventListener('abort', onAbort, { once: true })
      this.abortListener = () => ctx.signal?.removeEventListener('abort', onAbort)
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.abortListener) {
      this.abortListener()
      this.abortListener = null
    }
    this.fired.clear()
  }

  private async tick(): Promise<void> {
    if (this.tickInFlight) return
    this.tickInFlight = true
    try {
      const fileOwners = new Map<string, Set<string>>()
      const taskIDs = dedupe(this.options.getTaskIDs())
      for (const taskID of taskIDs) {
        const files = await changedFiles(this.options.repoDir, taskID).catch(() => [])
        if (files.length === 0) continue
        for (const file of files) {
          if (!fileOwners.has(file)) fileOwners.set(file, new Set())
          fileOwners.get(file)?.add(taskID)
        }
      }

      for (const group of buildConflictGroups(fileOwners)) {
        const key = `${group.taskIds.join(',')}::${group.files.join(',')}`
        if (this.fired.has(key)) continue
        this.fired.add(key)
        this.options.onConflict?.(group.taskIds, group.files)
      }
    } finally {
      this.tickInFlight = false
    }
  }
}

export function buildConflictGroups(
  fileOwners: Map<string, Set<string>>,
): ConflictDetectionResult[] {
  const grouped = new Map<string, ConflictDetectionResult>()

  for (const [file, owners] of fileOwners.entries()) {
    if (owners.size < 2) continue
    const taskIDs = [...owners].sort((a, b) => a.localeCompare(b))
    const key = taskIDs.join('|')
    if (!grouped.has(key)) {
      grouped.set(key, { taskIds: taskIDs, files: [] })
    }
    grouped.get(key)?.files.push(file)
  }

  return [...grouped.values()].map((group) => ({
    taskIds: group.taskIds,
    files: [...group.files].sort((a, b) => a.localeCompare(b)),
  }))
}

async function changedFiles(repoDir: string, taskID: string): Promise<string[]> {
  const worktreePath = await findTaskWorktree(repoDir, taskID)
  if (!worktreePath) return []

  const result = await gitRun(worktreePath, ['diff', '--name-only', 'HEAD'])
  if (result.exitCode !== 0) return []
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const normalized = value.trim()
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    out.push(normalized)
  }
  return out
}
