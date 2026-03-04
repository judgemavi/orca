import { createHash } from 'node:crypto'
import { findTaskWorktree } from './worktree'
import { gitRun } from '../shared/git'

export interface StuckDetectorOptions {
  repoDir: string
  intervalMS?: number
  maxCycles?: number
  getTaskIDs: () => string[]
  onStuck?: (taskID: string, reason: string) => void
}

export interface MonitorContext {
  signal?: AbortSignal
}

export interface RuntimeMonitor {
  start(ctx?: MonitorContext): void
  stop(): void
}

interface TaskState {
  lastHash: string
  noProgress: number
  history: string[]
}

export class StuckDetector implements RuntimeMonitor {
  private readonly states = new Map<string, TaskState>()
  private timer: ReturnType<typeof setInterval> | null = null
  private tickInFlight = false
  private abortListener: (() => void) | null = null

  constructor(private readonly options: StuckDetectorOptions) {}

  start(ctx: MonitorContext = {}): void {
    if (this.timer) return
    const interval = Math.max(1_000, this.options.intervalMS ?? 60_000)
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
    this.states.clear()
  }

  private async tick(): Promise<void> {
    if (this.tickInFlight) return
    this.tickInFlight = true
    try {
      const taskIDs = dedupe(this.options.getTaskIDs())
      const active = new Set(taskIDs)
      for (const tracked of this.states.keys()) {
        if (!active.has(tracked)) {
          this.states.delete(tracked)
        }
      }

      const maxCycles = Math.max(1, this.options.maxCycles ?? 3)
      for (const taskID of taskIDs) {
        const currentHash = await diffHash(this.options.repoDir, taskID).catch(() => '')
        if (!currentHash) continue

        const state = this.states.get(taskID) ?? {
          lastHash: '',
          noProgress: 0,
          history: [],
        }

        if (!state.lastHash) {
          state.lastHash = currentHash
          state.history.push(currentHash)
          this.states.set(taskID, state)
          continue
        }

        if (state.lastHash === currentHash) {
          state.noProgress += 1
          if (state.noProgress >= maxCycles) {
            this.options.onStuck?.(taskID, 'no progress')
            state.noProgress = 0
          }
        } else {
          state.noProgress = 0
          if (state.history.includes(currentHash)) {
            this.options.onStuck?.(taskID, 'edit-revert cycle')
          }
        }

        state.lastHash = currentHash
        state.history.push(currentHash)
        if (state.history.length > 6) {
          state.history.shift()
        }
        this.states.set(taskID, state)
      }
    } finally {
      this.tickInFlight = false
    }
  }
}

async function diffHash(repoDir: string, taskID: string): Promise<string> {
  const worktreePath = await findTaskWorktree(repoDir, taskID)
  if (!worktreePath) return ''

  const result = await gitRun(worktreePath, ['diff', '--stat', 'HEAD'])
  if (result.exitCode !== 0) return ''
  return createHash('sha256').update(result.stdout).digest('hex')
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
