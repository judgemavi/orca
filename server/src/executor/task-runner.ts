import type { Config, TaskStatus } from '../types'
import { loadPrompt } from '../prompts/loader'
import { resolveModelForPhase, resolveToolForPhase } from '../config/config'
import type { DriverRegistry } from '../driver/registry'
import { toolDefinition } from '../driver/registry'
import type { Driver, DriverEvent, HeadlessOpts } from '../driver/types'
import { runTool, type WorkerOutputLine } from '../worker/worker'
import { evaluateTaskOutcome } from './results'
import { evaluateQualityGates, takeValidationSnapshot, type QualityResult } from '../domain/quality'
import { gitRun } from '../shared/git'

export interface ResolvedTaskExecution {
  toolName: string
  driver: Driver
  model: string
}

export interface TaskRunInput {
  taskID: string
  phase: string
  title: string
  description: string
  plan?: string | null
  context?: string
  cwd: string
  worktreePath: string
  logsDir: string
  repoDir?: string
  baseBranch: string
  toolName: string
  driver: Driver
  model: string
  interactionLogPath?: string
  resumeSessionID?: string
  feedback?: string
  headlessOpts?: HeadlessOpts
  signal?: AbortSignal
  onOutputLine?: (line: WorkerOutputLine) => void | Promise<void>
  quality?: {
    enabled: boolean
    scopeCheck: boolean
    testDelta: boolean
    validationCommands: string[]
  }
}

export interface TaskRunResult {
  taskID: string
  phase: string
  toolName: string
  model: string
  status: TaskStatus
  interactionStatus: 'completed' | 'failed'
  exitCode: number
  signalCode: string | number | null
  sessionID: string
  inputTokens: number
  outputTokens: number
  estimatedCost: number
  events: DriverEvent[]
  logPath: string
  durationMS: number
  timedOut: boolean
  aborted: boolean
  diff: string
  filesChanged: string[]
  quality?: QualityResult
  error?: string
}

export function resolveTaskExecution(
  config: Config,
  registry: DriverRegistry,
  phase: string,
  toolOverride: string,
  modelOverride: string,
): ResolvedTaskExecution {
  const toolName = resolveToolForPhase(config, phase, toolOverride)
  const driver = toolDefinition(registry, toolName)
  if (!driver) {
    throw new Error(`tool not available: ${toolName}`)
  }

  const model = resolveModelForPhase(config, registry, phase, toolName, modelOverride)
  if (!model.trim()) {
    throw new Error(`model could not be resolved for tool ${JSON.stringify(toolName)}`)
  }

  return { toolName, driver, model }
}

export async function runTask(input: TaskRunInput): Promise<TaskRunResult> {
  const prompt = await buildPrompt(input)

  const beforeSnapshot =
    input.quality?.enabled &&
    input.quality?.testDelta &&
    (input.quality?.validationCommands?.length ?? 0) > 0
      ? await takeValidationSnapshot(input.worktreePath, input.quality.validationCommands)
      : null

  const result = await runTool({
    taskID: input.taskID,
    driverName: input.toolName,
    driver: input.driver,
    prompt,
    model: input.model,
    dir: input.worktreePath,
    resumeSessionID: input.resumeSessionID,
    feedback: input.feedback,
    headlessOpts: input.headlessOpts,
    cwd: input.cwd,
    logsDir: input.logsDir,
    logPath: input.interactionLogPath,
    signal: input.signal,
    onLine: input.onOutputLine,
  })

  const diff = await gitOutput(input.worktreePath, ['diff', input.baseBranch]).catch(() => '')
  const filesChangedRaw = await gitOutput(input.worktreePath, [
    'diff',
    '--name-only',
    input.baseBranch,
  ]).catch(() => '')
  const nameStatusRaw = await gitOutput(input.worktreePath, [
    'diff',
    '--name-status',
    input.baseBranch,
  ]).catch(() => '')
  const numStatRaw = await gitOutput(input.worktreePath, [
    'diff',
    '--numstat',
    input.baseBranch,
  ]).catch(() => '')

  const afterSnapshot =
    input.quality?.enabled &&
    input.quality?.testDelta &&
    (input.quality?.validationCommands?.length ?? 0) > 0
      ? await takeValidationSnapshot(input.worktreePath, input.quality.validationCommands)
      : null

  const quality = input.quality
    ? evaluateQualityGates({
        enabled: input.quality.enabled,
        scopeCheck: input.quality.scopeCheck,
        testDelta: input.quality.testDelta,
        taskId: input.taskID,
        taskTitle: input.title,
        diff,
        nameStatus: nameStatusRaw,
        numStat: numStatRaw,
        before: beforeSnapshot,
        after: afterSnapshot,
      })
    : undefined

  const outputTail = await readTail(result.logPath, 8_000)
  const outcome = evaluateTaskOutcome({
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    aborted: result.aborted,
    diff,
    outputTail,
    workerError: result.error,
    quality: quality ?? null,
  })

  return {
    taskID: input.taskID,
    phase: input.phase,
    toolName: input.toolName,
    model: input.model,
    status: outcome.taskStatus,
    interactionStatus: outcome.interactionStatus,
    exitCode: result.exitCode,
    signalCode: result.signalCode,
    sessionID: result.sessionID,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    estimatedCost: result.estimatedCost,
    events: result.events,
    logPath: result.logPath,
    durationMS: result.durationMS,
    timedOut: result.timedOut,
    aborted: result.aborted,
    diff,
    filesChanged: normalizeList(filesChangedRaw.split('\n')),
    quality,
    error: outcome.error,
  }
}

async function buildPrompt(input: Pick<TaskRunInput, 'title' | 'description' | 'plan' | 'context' | 'feedback' | 'resumeSessionID' | 'repoDir'>): Promise<string> {
  const repoDir = input.repoDir ?? ''
  if (!repoDir) throw new Error('repoDir is required for prompt loading')
  const [outputStyle, executorStyle] = await Promise.all([
    loadPrompt(repoDir, 'outputStyle'),
    loadPrompt(repoDir, 'executorStyle'),
  ])

  const parts: string[] = []

  if (outputStyle.trim()) parts.push(outputStyle.trim())
  if (executorStyle.trim()) parts.push(executorStyle.trim())
  if (input.context?.trim()) parts.push(input.context.trim())
  if (input.plan?.trim()) parts.push(`## Implementation Plan\n\n${input.plan.trim()}`)

  const taskCore = [input.title.trim(), input.description.trim()].filter(Boolean).join('\n\n')
  if (taskCore) parts.push(`## Task\n\n${taskCore}`)

  if (!input.resumeSessionID?.trim() && input.feedback?.trim()) {
    parts.push(`## Reviewer Feedback\n\n${input.feedback.trim()}`)
  }

  return parts.join('\n\n---\n\n')
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  const { stdout, stderr, exitCode } = await gitRun(cwd, args)
  if (exitCode !== 0) {
    const message = stderr || `git ${args.join(' ')} failed with exit code ${exitCode}`
    throw new Error(message)
  }
  return stdout
}

async function readTail(path: string, maxBytes: number): Promise<string> {
  const text = await Bun.file(path).text().catch(() => '')
  if (text.length <= maxBytes) return text
  return text.slice(-maxBytes)
}

function normalizeList(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []

  for (const value of values) {
    const normalized = value.trim()
    if (!normalized) continue
    if (seen.has(normalized)) continue
    seen.add(normalized)
    out.push(normalized)
  }

  return out
}
