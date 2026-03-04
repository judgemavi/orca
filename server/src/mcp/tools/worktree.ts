import { stat, rm } from 'node:fs/promises'
import { z } from 'zod'
import type { Tool } from '../types'
import { gitRun as sharedGitRun } from '../../shared/git'
import { defineTool } from '../define-tool'

interface WorktreeInfo {
  path: string
  branch: string
  taskId: string
  ageHours: number
}

const worktreeStatusSchema = z.object({})

const worktreeCleanupSchema = z.object({
  dryRun: z.preprocess(
    (value) => (value === undefined ? false : value),
    z.coerce.boolean().default(false),
  ),
  maxAgeHours: z.preprocess(
    (value) => (value === undefined ? 168 : value),
    z.coerce.number().int().min(1).default(168),
  ),
})

export function worktreeTools(repoDir: string): Tool[] {
  return [
    defineTool({
      name: 'worktree_status',
      description: 'List task worktrees and approximate age',
      schema: worktreeStatusSchema,
      handler: async () => {
        const worktrees = await listWorktrees(repoDir)
        return { worktrees }
      },
    }),
    defineTool({
      name: 'worktree_cleanup',
      description: 'Remove stale worktrees',
      schema: worktreeCleanupSchema,
      handler: async (input) => {
        const dryRun = input.dryRun
        const maxAgeHours = input.maxAgeHours

        const worktrees = await listWorktrees(repoDir)
        const stale = worktrees.filter((item) => item.ageHours >= maxAgeHours)
        if (dryRun) {
          return { removed: stale.map((item) => item.taskId), dryRun: true, errors: [] }
        }

        const removed: string[] = []
        const errors: string[] = []
        for (const item of stale) {
          const removeFromGit = await runGit(repoDir, ['worktree', 'remove', '--force', item.path], true)
          if (removeFromGit.code !== 0) {
            errors.push(removeFromGit.stderr || removeFromGit.stdout || `failed removing ${item.path}`)
            continue
          }
          await rm(item.path, { recursive: true, force: true }).catch(() => {})
          removed.push(item.taskId)
        }
        return { removed, errors, dryRun: false }
      },
    }),
  ]
}

async function listWorktrees(repoDir: string): Promise<WorktreeInfo[]> {
  const raw = await runGit(repoDir, ['worktree', 'list', '--porcelain'], false)
  if (raw.code !== 0) return []

  const out: WorktreeInfo[] = []
  const blocks = raw.stdout.split('\n\n').map((block) => block.trim()).filter(Boolean)
  for (const block of blocks) {
    const lines = block.split('\n')
    const worktreeLine = lines.find((line) => line.startsWith('worktree '))
    if (!worktreeLine) continue
    const path = worktreeLine.slice('worktree '.length).trim()
    const branchLine = lines.find((line) => line.startsWith('branch '))
    const branch = branchLine ? branchLine.slice('branch '.length).replace('refs/heads/', '').trim() : ''

    const taskID = extractTaskID(path)
    const ageHours = await computeAgeHours(path)
    out.push({
      path,
      branch,
      taskId: taskID,
      ageHours: ageHours,
    })
  }
  return out
}

function extractTaskID(path: string): string {
  const base = path.replace(/\/+$/g, '').split('/').pop() ?? ''
  const match = base.match(/^task-([^-]+)(?:--.*)?$/)
  return match?.[1] ?? base
}

async function computeAgeHours(path: string): Promise<number> {
  try {
    const info = await stat(path)
    const ageMs = Date.now() - info.mtimeMs
    return Math.max(0, Math.floor(ageMs / (1000 * 60 * 60)))
  } catch {
    return 0
  }
}

async function runGit(
  repoDir: string,
  args: string[],
  allowFailure: boolean,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const result = await sharedGitRun(repoDir, args)
  const code = result.exitCode
  const stdout = result.stdout
  const stderr = result.stderr
  if (!allowFailure && code !== 0) {
    throw new Error(stderr || stdout || `git ${args.join(' ')} failed`)
  }
  return { code, stdout, stderr }
}
