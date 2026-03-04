import { Hono } from 'hono'
import { cleanupTaskArtifacts } from '../../domain/task-cleanup'
import type { TaskStore } from '../../store/tasks'
import type { EventSink } from '../ws'
import { asyncOp } from './async-op'
import { broadcast, parseBody } from './utils'
import { gitRun } from '../../shared/git'

interface CleanupBody {
  dryRun?: boolean
}

interface WorktreeEntry {
  path: string
  branch: string
  taskID: string
}

export function registerCleanupHandlers(
  app: Hono,
  deps: {
    repoDir: string
    taskStore: TaskStore
    sink: EventSink
  },
) {
  app.post('/cleanup', async (c) => {
    const body = await parseBody<CleanupBody>(c.req)
    const dryRun = Boolean(body.dryRun)
    const stale = await listStaleTaskWorktrees(deps.repoDir, deps.taskStore)

    if (dryRun) {
      return c.json({
        data: {
          removed: stale.length,
          worktrees: stale.map((entry) => entry.branch || entry.path),
          dryRun: true,
        },
      })
    }

    asyncOp(deps.sink, {
      started: {
        name: 'cleanup.started',
      },
      completed: {
        name: 'cleanup.completed',
        payload: ({ result }) => result,
      },
      run: async () => {
        const removed: string[] = []
        const warnings: string[] = []

        for (const entry of stale) {
          const cleanup = await cleanupTaskArtifacts({
            repoDir: deps.repoDir,
            taskID: entry.taskID,
          })
          if (cleanup.worktreeRemoved || cleanup.removedBranches.length > 0) {
            removed.push(entry.taskID)
            broadcast(deps.sink, 'cleanup.progress', {
              taskId: entry.taskID,
              branch: entry.branch,
            })
          }
          if (cleanup.warnings.length > 0) {
            warnings.push(...cleanup.warnings)
          }
        }

        return {
          removed: removed.length,
          taskIds: removed,
          warnings,
        }
      },
    })

    return c.json({ data: { status: 'running' } }, 202)
  })
}

async function listStaleTaskWorktrees(repoDir: string, taskStore: TaskStore): Promise<WorktreeEntry[]> {
  const listed = await listWorktrees(repoDir)
  const stale: WorktreeEntry[] = []

  for (const item of listed) {
    if (!item.taskID) continue
    if (!item.branch.startsWith('orca/task-')) continue

    const task = await taskStore.get(item.taskID)
    if (!task) {
      stale.push(item)
      continue
    }
    if (task.status === 'approved' || task.status === 'failed' || task.status === 'merged') {
      stale.push(item)
    }
  }

  return stale
}

async function listWorktrees(repoDir: string): Promise<WorktreeEntry[]> {
  const result = await gitRun(repoDir, ['worktree', 'list', '--porcelain'])
  if (result.exitCode !== 0) return []

  const entries: WorktreeEntry[] = []
  const blocks = result.stdout
    .split('\n\n')
    .map((block) => block.trim())
    .filter(Boolean)
  for (const block of blocks) {
    const lines = block.split('\n')
    const worktreeLine = lines.find((line) => line.startsWith('worktree '))
    if (!worktreeLine) continue
    const path = worktreeLine.slice('worktree '.length).trim()
    const branchLine = lines.find((line) => line.startsWith('branch '))
    const branch = branchLine
      ? branchLine.slice('branch '.length).replace('refs/heads/', '').trim()
      : ''
    if (branch === 'main' || branch === 'master' || branch === 'orca/integration') continue
    entries.push({
      path,
      branch,
      taskID: extractTaskID(branch, path),
    })
  }
  return entries
}

function extractTaskID(branch: string, path: string): string {
  const source = branch.startsWith('orca/task-')
    ? branch.slice('orca/'.length)
    : path.replace(/\/+$/g, '').split('/').pop() ?? ''
  const match = source.match(/^task-([^-]+)(?:--.*)?$/)
  return match?.[1] ?? ''
}
