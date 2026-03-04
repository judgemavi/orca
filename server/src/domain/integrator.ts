import type { DriverRegistry } from '../driver/registry'
import type { InteractionStore } from '../store/interactions'
import type { TaskStore } from '../store/tasks'
import { TaskStatus } from '../types'
import type { Config } from '../types'
import {
  formatRefLockContentionError,
  gitRun as sharedGitRun,
  gitRunWithRefLockRetry,
  isRefLockErrorResult,
} from '../shared/git'
import { findTaskWorktree } from './worktree'
import { streamToText } from '../shared/stream'
import {
  mergeWithConflictResolutionUnlocked,
  readConflictFiles,
} from './conflict-resolution'

export interface MergeValidationResult {
  passed: boolean
  command?: string
  output?: string
}

export interface MergeResult {
  taskId: string
  status: typeof TaskStatus.merged | typeof TaskStatus.failed
  branch: string
  worktreePath: string
  rebaseAttempted: boolean
  conflicts: string[]
  validation: MergeValidationResult
  error?: string
}

export interface IntegratorDeps {
  repoDir: string
  integrationBranch: string
  validationCommands: string[]
  taskStore: TaskStore
}

export async function assertTaskMergeable(taskID: string, taskStore: TaskStore): Promise<void> {
  const task = await taskStore.get(taskID)
  if (!task) throw new Error(`task ${taskID} not found`)

  if (task.status !== TaskStatus.approved && task.status !== TaskStatus.review) {
    throw new Error(`task ${taskID} is ${task.status}; expected approved/review`)
  }

  for (const depID of task.dependsOn) {
    const dep = await taskStore.get(depID)
    if (!dep) {
      throw new Error(`dependency task ${depID} not found`)
    }
    if (dep.status !== TaskStatus.merged) {
      throw new Error(`dependency ${depID} must be merged before ${taskID}`)
    }
  }
}

export async function mergeApprovedTasks(taskStore: TaskStore): Promise<{ merged: string[]; failed: string[] }> {
  const approved = await taskStore.listByStatus(TaskStatus.approved)
  const sorted = await taskStore.sortTasksTopologically(approved.map((task) => task.id))

  const merged: string[] = []
  const failed: string[] = []

  for (const taskID of sorted) {
    try {
      await assertTaskMergeable(taskID, taskStore)
      await taskStore.updateStatus(taskID, TaskStatus.merged)
      merged.push(taskID)
    } catch {
      failed.push(taskID)
    }
  }

  return { merged, failed }
}

export async function mergeTaskWithGit(
  taskID: string,
  deps: IntegratorDeps,
): Promise<MergeResult> {
  return mergeTaskWithGitUnlocked(taskID, deps)
}

export async function mergeApprovedTasksWithGit(
  deps: IntegratorDeps,
): Promise<{ merged: string[]; failed: string[]; results: MergeResult[] }> {
  const approved = await deps.taskStore.listByStatus(TaskStatus.approved)
  const sorted = await deps.taskStore.sortTasksTopologically(approved.map((task) => task.id))

  const merged: string[] = []
  const failed: string[] = []
  const results: MergeResult[] = []
  const failedSet = new Set<string>()

  for (const taskID of sorted) {
    const task = await deps.taskStore.get(taskID)
    if (!task) {
      failed.push(taskID)
      failedSet.add(taskID)
      continue
    }

    if (task.dependsOn.some((depID) => failedSet.has(depID))) {
      const skipped: MergeResult = {
        taskId: taskID,
        status: TaskStatus.failed,
        branch: '',
        worktreePath: '',
        rebaseAttempted: false,
        conflicts: [],
        validation: { passed: false },
        error: 'skipped: dependency failed to merge in this batch',
      }
      failed.push(taskID)
      failedSet.add(taskID)
      results.push(skipped)
      continue
    }

    const result = await mergeTaskWithGit(taskID, deps)
    results.push(result)
    if (result.status === TaskStatus.merged) merged.push(taskID)
    else {
      failed.push(taskID)
      failedSet.add(taskID)
    }
  }

  return { merged, failed, results }
}

export interface ConflictResolutionDeps extends IntegratorDeps {
  config: Config
  registry: DriverRegistry
  interactionStore: InteractionStore
  logsDir: string
}

export async function mergeWithConflictResolution(
  taskID: string,
  deps: ConflictResolutionDeps,
): Promise<MergeResult> {
  return mergeWithConflictResolutionUnlocked(taskID, deps, {
    mergeTaskWithGitUnlocked,
    resolveTaskBranch,
    runValidation,
    rollbackMergedCommit,
    cleanupTaskWorktree,
    gitRun,
  })
}

async function mergeTaskWithGitUnlocked(taskID: string, deps: IntegratorDeps): Promise<MergeResult> {
  await assertTaskMergeable(taskID, deps.taskStore)

  const task = await deps.taskStore.get(taskID)
  if (!task) throw new Error(`task ${taskID} not found`)

  const worktreePath = await findTaskWorktree(deps.repoDir, taskID)
  const branch = await resolveTaskBranch(deps.repoDir, taskID, worktreePath)
  const base = deps.integrationBranch.trim()

  const failed = (message: string, opts?: Partial<MergeResult>): MergeResult => ({
    taskId: taskID,
    status: TaskStatus.failed,
    branch,
    worktreePath: worktreePath,
    rebaseAttempted: Boolean(opts?.rebaseAttempted),
    conflicts: opts?.conflicts ?? [],
    validation: opts?.validation ?? { passed: false },
    error: message,
  })

  const checkout = await gitRunWithRefLockRetry(deps.repoDir, ['checkout', base])
  if (checkout.code !== 0) {
    if (isRefLockErrorResult(checkout)) {
      return failed(formatRefLockContentionError(checkout.stderr))
    }
    return failed(`checkout ${base} failed: ${checkout.stderr || checkout.stdout}`)
  }

  const mergeMessage = `orca: merge task-${taskID}`
  let rebaseAttempted = false
  let conflicts: string[] = []

  let merged = await gitRunWithRefLockRetry(
    deps.repoDir,
    ['merge', branch, '--no-ff', '-m', mergeMessage],
  )
  if (merged.code !== 0) {
    if (isRefLockErrorResult(merged)) {
      return failed(formatRefLockContentionError(merged.stderr))
    }
    conflicts = await readConflictFiles(deps.repoDir)
    await gitRun(deps.repoDir, ['merge', '--abort'], true)
    rebaseAttempted = true

    const rebased = await rebaseTaskBranch(deps.repoDir, base, branch, worktreePath)
    if (!rebased.ok) {
      return failed(rebased.error || 'rebase failed', {
        rebaseAttempted: true,
        conflicts,
      })
    }

    merged = await gitRunWithRefLockRetry(
      deps.repoDir,
      ['merge', branch, '--no-ff', '-m', `${mergeMessage} (after rebase)`],
    )
    if (merged.code !== 0) {
      if (isRefLockErrorResult(merged)) {
        return failed(formatRefLockContentionError(merged.stderr), {
          rebaseAttempted: true,
          conflicts,
        })
      }
      conflicts = await readConflictFiles(deps.repoDir)
      await gitRun(deps.repoDir, ['merge', '--abort'], true)
      return failed(merged.stderr || merged.stdout || 'merge failed after rebase', {
        rebaseAttempted: true,
        conflicts,
      })
    }
  }

  const validation = await runValidation(deps.repoDir, deps.validationCommands)
  if (!validation.passed) {
    const rollbackError = await rollbackMergedCommit(deps.repoDir)
    return failed(
      rollbackError
        ? `validation failed${validation.command ? ` (${validation.command})` : ''} (rollback failed: ${rollbackError})`
        : `validation failed${validation.command ? ` (${validation.command})` : ''}`,
      {
        rebaseAttempted: rebaseAttempted,
        conflicts,
        validation,
      },
    )
  }

  await cleanupTaskWorktree(deps.repoDir, worktreePath, branch, taskID)

  return {
    taskId: taskID,
    status: TaskStatus.merged,
    branch,
    worktreePath: worktreePath,
    rebaseAttempted: rebaseAttempted,
    conflicts,
    validation,
  }
}

async function resolveTaskBranch(repoDir: string, taskID: string, worktreePath: string): Promise<string> {
  if (worktreePath) {
    const branchFromWorktree = await gitRun(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'], true)
    if (branchFromWorktree.code === 0 && branchFromWorktree.stdout.trim()) {
      return branchFromWorktree.stdout.trim()
    }
  }

  const exact = `orca/task-${taskID}`
  const list = await gitRun(repoDir, ['branch', '--list', `${exact}*`], true)
  const candidate = list.stdout
    .split('\n')
    .map((line) => line.replace(/^[*+\s]+/, '').trim())
    .find(Boolean)

  return candidate || exact
}

async function runValidation(repoDir: string, commands: string[]): Promise<MergeValidationResult> {
  if (commands.length === 0) {
    return { passed: true }
  }

  for (const raw of commands) {
    const command = raw.trim()
    if (!command) continue
    const child = Bun.spawn({
      cmd: ['sh', '-lc', command],
      cwd: repoDir,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })

    const [stdout, stderr, code] = await Promise.all([
      streamToText(child.stdout),
      streamToText(child.stderr),
      child.exited,
    ])

    if (code !== 0) {
      return {
        passed: false,
        command,
        output: `${stdout}\n${stderr}`.trim(),
      }
    }
  }

  return { passed: true }
}

async function rebaseTaskBranch(
  repoDir: string,
  integrationBranch: string,
  branch: string,
  worktreePath: string,
): Promise<{ ok: boolean; error?: string }> {
  if (worktreePath) {
    const rebase = await gitRunWithRefLockRetry(worktreePath, ['rebase', integrationBranch])
    if (rebase.code === 0) return { ok: true }
    if (isRefLockErrorResult(rebase)) {
      return { ok: false, error: formatRefLockContentionError(rebase.stderr) }
    }
    await gitRun(worktreePath, ['rebase', '--abort'], true)
    return { ok: false, error: rebase.stderr || rebase.stdout || 'rebase failed in worktree' }
  }

  const checkoutTask = await gitRunWithRefLockRetry(repoDir, ['checkout', branch])
  if (checkoutTask.code !== 0) {
    if (isRefLockErrorResult(checkoutTask)) {
      return { ok: false, error: formatRefLockContentionError(checkoutTask.stderr) }
    }
    return { ok: false, error: checkoutTask.stderr || checkoutTask.stdout }
  }

  const rebased = await gitRunWithRefLockRetry(repoDir, ['rebase', integrationBranch])
  if (rebased.code !== 0) {
    if (isRefLockErrorResult(rebased)) {
      return { ok: false, error: formatRefLockContentionError(rebased.stderr) }
    }
    await gitRun(repoDir, ['rebase', '--abort'], true)
    await gitRun(repoDir, ['checkout', integrationBranch], true)
    return { ok: false, error: rebased.stderr || rebased.stdout }
  }

  const checkoutIntegration = await gitRunWithRefLockRetry(repoDir, ['checkout', integrationBranch])
  if (checkoutIntegration.code !== 0) {
    if (isRefLockErrorResult(checkoutIntegration)) {
      return { ok: false, error: formatRefLockContentionError(checkoutIntegration.stderr) }
    }
    return { ok: false, error: checkoutIntegration.stderr || checkoutIntegration.stdout }
  }

  return { ok: true }
}

async function cleanupTaskWorktree(
  repoDir: string,
  worktreePath: string,
  branch: string,
  taskID: string,
) {
  if (worktreePath) {
    await gitRun(repoDir, ['worktree', 'remove', '--force', worktreePath], true)
  }
  if (branch && branch !== `orca/task-${taskID}`) {
    await gitRun(repoDir, ['branch', '-d', branch], true)
  } else if (branch) {
    await gitRun(repoDir, ['branch', '-d', branch], true)
  }
}

async function rollbackMergedCommit(repoDir: string): Promise<string | undefined> {
  const reset = await gitRunWithRefLockRetry(repoDir, ['reset', '--hard', 'HEAD~1'])
  if (reset.code === 0) return undefined
  return reset.stderr || reset.stdout || 'git reset --hard HEAD~1 failed'
}

async function gitRun(
  cwd: string,
  args: string[],
  allowFailure = false,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const result = await sharedGitRun(cwd, args)
  const stdout = result.stdout
  const stderr = result.stderr
  const code = result.exitCode
  if (!allowFailure && code !== 0) {
    throw new Error(stderr || stdout || `git ${args.join(' ')} failed`)
  }
  return { code, stdout, stderr }
}
