import clsx from 'clsx'
import { Check } from 'lucide-react'
import type { OrchestratorMessage } from '../../types'

export const TASK_PHASE_SEQUENCE = [
  'create',
  'plan',
  'execute',
  'review',
  'merge',
  'retro',
] as const

export type TaskPhase = (typeof TASK_PHASE_SEQUENCE)[number]

export interface TaskPhaseProgressState {
  taskId: string | null
  currentPhase: TaskPhase
  status: string | null
}

interface Props {
  progress: TaskPhaseProgressState
  className?: string
}

const TASK_PHASE_LABELS: Record<TaskPhase, string> = {
  create: 'Create',
  plan: 'Plan',
  execute: 'Execute',
  review: 'Review',
  merge: 'Merge',
  retro: 'Retro',
}

const TOOL_PHASES: Record<string, TaskPhase> = {
  tasks_create: 'create',
  tasks_plan_generate: 'plan',
  tasks_plan_evaluate: 'plan',
  tasks_approve_plan: 'plan',
  tasks_request_plan_changes: 'plan',
  breakdown: 'plan',
  tasks_start: 'execute',
  tasks_resume: 'execute',
  tasks_stop: 'execute',
  ai_review: 'review',
  tasks_reviews: 'review',
  tasks_request_changes: 'review',
  tasks_approve: 'review',
  merge: 'merge',
  tasks_merge: 'merge',
  tasks_retro: 'retro',
}

const STATUS_PHASES: Record<string, TaskPhase> = {
  pending: 'create',
  planned: 'plan',
  broken_down: 'plan',
  running: 'execute',
  stopped: 'execute',
  failed: 'execute',
  review: 'review',
  approved: 'merge',
  merged: 'retro',
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function parseJSON(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function normalizeToolName(value: string): string {
  return value.trim().replace(/^mcp__orca__/, '')
}

function getToolName(message: OrchestratorMessage): string {
  const fromMetadata = asString(message.metadata.name)
  const raw = fromMetadata || message.content
  return normalizeToolName(raw)
}

function phaseFromTool(toolName: string): TaskPhase | null {
  return TOOL_PHASES[normalizeToolName(toolName)] ?? null
}

function phaseFromStatus(status: string | null): TaskPhase | null {
  if (!status) return null
  return STATUS_PHASES[status.trim().toLowerCase()] ?? null
}

function toObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function firstString(values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed) return trimmed
  }
  return null
}

function findTaskIdInObject(obj: Record<string, unknown>): string | null {
  const explicit = firstString([obj.task_id, obj.id])
  if (explicit) return explicit

  const taskIDs = obj.task_ids
  if (Array.isArray(taskIDs)) {
    for (const value of taskIDs) {
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
  }

  return null
}

function findStatusInObject(obj: Record<string, unknown>): string | null {
  return firstString([obj.status, obj.state])
}

function parseTaskContext(payload: unknown): { taskId: string | null; status: string | null } {
  if (Array.isArray(payload)) {
    for (let i = payload.length - 1; i >= 0; i -= 1) {
      const parsed = parseTaskContext(payload[i])
      if (parsed.taskId || parsed.status) return parsed
    }
    return { taskId: null, status: null }
  }

  const obj = toObject(payload)
  if (!obj) return { taskId: null, status: null }

  const directTaskId = findTaskIdInObject(obj)
  const directStatus = findStatusInObject(obj)
  if (directTaskId || directStatus) {
    return { taskId: directTaskId, status: directStatus }
  }

  const nestedTask = parseTaskContext(obj.task)
  if (nestedTask.taskId || nestedTask.status) return nestedTask

  const nestedTasks = parseTaskContext(obj.tasks)
  if (nestedTasks.taskId || nestedTasks.status) return nestedTasks

  const nestedData = parseTaskContext(obj.data)
  if (nestedData.taskId || nestedData.status) return nestedData

  return { taskId: null, status: null }
}

function parseTaskIdFromArgs(args: string): string | null {
  const payload = parseJSON(args)
  if (!payload) return null
  return parseTaskContext(payload).taskId
}

function normalizeStatus(status: string | null): string | null {
  if (!status) return null
  const trimmed = status.trim().toLowerCase()
  return trimmed || null
}

function shortTaskId(taskId: string): string {
  return taskId.length <= 8 ? taskId : taskId.slice(0, 8)
}

function fallbackState(
  value: TaskPhaseProgressState | null,
): { taskId: string | null; status: string | null } {
  if (value === null) {
    return { taskId: null, status: null }
  }
  return { taskId: value.taskId, status: value.status }
}

export function parseTaskPhaseProgress(
  messages: OrchestratorMessage[],
): TaskPhaseProgressState | null {
  const toolNameByID = new Map<string, string>()
  let latest: TaskPhaseProgressState | null = null

  for (const message of messages) {
    if (message.role === 'tool_use') {
      const toolName = getToolName(message)
      const toolUseID = asString(message.metadata.tool_use_id)
      if (toolUseID) toolNameByID.set(toolUseID, toolName)

      const phase = phaseFromTool(toolName)
      if (!phase) continue
      const taskId = parseTaskIdFromArgs(asString(message.metadata.args))
      const previous = fallbackState(latest)
      latest = {
        taskId: taskId ?? previous.taskId,
        currentPhase: phase,
        status: previous.status,
      }
      continue
    }

    if (message.role !== 'tool_result') continue

    const toolUseID = asString(message.metadata.tool_use_id)
    const toolName =
      normalizeToolName(asString(message.metadata.name)) ||
      (toolUseID ? normalizeToolName(toolNameByID.get(toolUseID) ?? '') : '')
    const payload = parseJSON(message.content)
    const parsed = parseTaskContext(payload)
    const status = normalizeStatus(parsed.status)
    const statusPhase = phaseFromStatus(status)
    const toolPhase = phaseFromTool(toolName)
    const phase = statusPhase ?? toolPhase
    if (!phase) continue

    const previous = fallbackState(latest)
    latest = {
      taskId: parsed.taskId ?? previous.taskId,
      currentPhase: phase,
      status: status ?? previous.status,
    }
  }

  return latest
}

export function TaskPhaseProgress({ progress, className }: Props) {
  const currentIndex = TASK_PHASE_SEQUENCE.indexOf(progress.currentPhase)

  return (
    <div
      className={clsx(
        'rounded-lg border border-border-subtle bg-surface-alt/40 px-3 py-2',
        className,
      )}
    >
      <div className="mb-2 flex items-center justify-between gap-2 text-[11px] text-muted">
        <span>
          Task Progress
          {progress.taskId ? (
            <>
              {' · '}
              <span className="font-mono text-foreground">
                {shortTaskId(progress.taskId)}
              </span>
            </>
          ) : null}
        </span>
        {progress.status ? (
          <span className="rounded border border-border-subtle px-1.5 py-0.5 font-mono text-[10px] text-foreground">
            {progress.status}
          </span>
        ) : null}
      </div>

      <div className="overflow-x-auto pb-1">
        <ol className="flex min-w-max items-start gap-0.5">
          {TASK_PHASE_SEQUENCE.map((phase, index) => {
            const completed = index < currentIndex
            const current = index === currentIndex
            return (
              <li key={phase} className="flex items-center">
                <div className="flex flex-col items-center px-1.5">
                  <span
                    className={clsx(
                      'flex h-6 w-6 items-center justify-center rounded-full border text-[11px]',
                      completed
                        ? 'border-accent bg-accent text-white'
                        : current
                          ? 'border-accent bg-surface text-accent'
                          : 'border-border-subtle bg-surface text-muted',
                    )}
                  >
                    {completed ? <Check size={12} /> : index + 1}
                  </span>
                  <span
                    className={clsx(
                      'mt-1 text-[10px]',
                      current || completed ? 'text-foreground' : 'text-muted',
                    )}
                  >
                    {TASK_PHASE_LABELS[phase]}
                  </span>
                </div>
                {index < TASK_PHASE_SEQUENCE.length - 1 ? (
                  <span
                    className={clsx(
                      '-mt-4 h-[1px] w-6',
                      completed ? 'bg-accent' : 'bg-border-subtle',
                    )}
                  />
                ) : null}
              </li>
            )
          })}
        </ol>
      </div>
    </div>
  )
}
