import type { ReactNode } from 'react'
import {
  extractPlanText,
  normalizeToolName,
  parseBreakdownPayload,
  parseCreatedTask,
  parseEvaluationPayload,
  parseMemoryEntries,
  parseProjectStatusPayload,
  parseReviewPayload,
  parseToolTasks,
  toPrettyJSON,
} from '../../lib/orchestratorRichContent'
import {
  detectPhaseActions,
  parseToolResultPayload,
} from '../../lib/orchestratorPhaseActions'
import { BreakdownCard } from '../shared/BreakdownCard'
import { EvaluationCard } from '../shared/EvaluationCard'
import { PlanMarkdownCard } from '../shared/PlanMarkdownCard'
import { ReviewResultCard } from '../shared/ReviewResultCard'
import { ActionButtons } from './ActionButtons'
import { InlineTaskCard } from './InlineTaskCard'

interface ToolResultData {
  content: string
  isError?: boolean
}

interface Props {
  name: string
  args: string
  result?: ToolResultData
  toolUseId?: string
  showPhaseActions?: boolean
  onAction?: (response: string) => void | Promise<void>
  actionsDisabled?: boolean
  actionMessageId?: string
}

const TOOL_LABELS: Record<string, string> = {
  tasks_create: 'Creating task',
  tasks_list: 'Listing tasks',
  tasks_update: 'Updating task',
  tasks_delete: 'Deleting task',
  tasks_start: 'Starting task',
  tasks_stop: 'Stopping task',
  tasks_resume: 'Resuming task',
  tasks_plan_generate: 'Generating plan',
  tasks_plan_evaluate: 'Evaluating task complexity',
  tasks_approve_plan: 'Approving plan',
  tasks_request_plan_changes: 'Requesting plan changes',
  tasks_approve: 'Approving task',
  tasks_request_changes: 'Requesting changes',
  tasks_merge: 'Merging task',
  tasks_retro: 'Running retrospective',
  ai_review: 'Running code review',
  breakdown: 'Breaking down task',
  explore: 'Exploring codebase',
  memory_search: 'Searching memory',
  memory_query: 'Querying memory',
  memory_sync: 'Syncing memory',
  project_status: 'Checking project status',
  merge: 'Merging changes',
}

function toolLabel(normalizedName: string): string {
  return TOOL_LABELS[normalizedName] ?? normalizedName
}

function formatConfidence(confidence?: number): string {
  if (confidence === undefined || !Number.isFinite(confidence)) return 'n/a'
  if (confidence <= 1) return `${Math.round(confidence * 100)}%`
  return `${Math.round(confidence)}%`
}

function TaskListResult({ payload }: { payload: unknown }) {
  const tasks = parseToolTasks(payload)
  if (tasks.length === 0) return null

  return (
    <div className="space-y-1.5">
      {tasks.map((task) => (
        <InlineTaskCard key={task.id} taskId={task.id} task={task} />
      ))}
    </div>
  )
}

function TaskCreateResult({ payload }: { payload: unknown }) {
  const createdTask = parseCreatedTask(payload)
  if (!createdTask) return null
  return <InlineTaskCard taskId={createdTask.id} task={createdTask} />
}

function MemoryResult({ payload }: { payload: unknown }) {
  const entries = parseMemoryEntries(payload)
  if (entries.length === 0) return null

  return (
    <div className="space-y-2">
      {entries.map((entry) => (
        <div
          key={`${entry.id}-${entry.content.slice(0, 24)}`}
          className="rounded-md border border-border-subtle bg-surface-alt/40 px-2 py-2"
        >
          <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
            <span className="font-mono text-muted">{entry.id.slice(0, 8)}</span>
            <span className="rounded bg-surface px-1.5 py-0.5">
              {entry.category}
            </span>
            {entry.sourceType ? (
              <span className="rounded bg-surface px-1.5 py-0.5">
                {entry.sourceType}
              </span>
            ) : null}
            <span
              className={`rounded px-1.5 py-0.5 ${entry.stale ? 'bg-amber-500/15 text-amber-700' : 'bg-emerald-500/15 text-emerald-700'}`}
            >
              {entry.stale ? 'stale' : 'fresh'}
            </span>
            <span className="text-muted">
              confidence {formatConfidence(entry.confidence)}
            </span>
          </div>
          <p className="mt-1 text-xs whitespace-pre-wrap">{entry.content}</p>
          {entry.tags.length > 0 ? (
            <div className="mt-1 flex flex-wrap gap-1">
              {entry.tags.map((tag) => (
                <span
                  key={tag}
                  className="rounded bg-surface px-1.5 py-0.5 text-[11px] text-muted"
                >
                  #{tag}
                </span>
              ))}
            </div>
          ) : null}
          {entry.filePaths.length > 0 ? (
            <div className="mt-1 text-[11px] text-muted">
              files: {entry.filePaths.slice(0, 3).join(', ')}
              {entry.filePaths.length > 3 ? ' ...' : ''}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  )
}

function ProjectStatusResult({ payload }: { payload: unknown }) {
  const status = parseProjectStatusPayload(payload)
  if (!status) return null

  const statusPairs = Object.entries(status.byStatus).sort((a, b) => b[1] - a[1])
  if (statusPairs.length === 0 && status.totalTasks === undefined) return null

  return (
    <div className="rounded-md border border-border-subtle bg-surface-alt/40 p-2">
      <div className="mb-2 flex items-center justify-between text-xs">
        <span className="font-medium">{status.project ?? 'Project status'}</span>
        {status.totalTasks !== undefined ? (
          <span className="text-muted">total {status.totalTasks}</span>
        ) : null}
      </div>
      <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
        {statusPairs.map(([name, count]) => (
          <div
            key={name}
            className="rounded border border-border-subtle bg-surface px-2 py-1 text-xs"
          >
            <div className="text-muted">{name}</div>
            <div className="font-semibold">{count}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function renderRichResult(toolName: string, payload: unknown): ReactNode | null {
  switch (toolName) {
    case 'tasks_list':
      return <TaskListResult payload={payload} />
    case 'tasks_create':
      return <TaskCreateResult payload={payload} />
    case 'tasks_plan_generate': {
      const planText = extractPlanText(payload)
      if (!planText) return null
      const source = asRecord(payload)
      const rawTaskId = source?.task_id
      const rawSaved = source?.saved
      const taskId =
        typeof rawTaskId === 'string' && rawTaskId.trim() !== ''
          ? rawTaskId.trim()
          : undefined
      const saved = typeof rawSaved === 'boolean' ? rawSaved : undefined
      return <PlanMarkdownCard planText={planText} taskId={taskId} saved={saved} collapsible />
    }
    case 'tasks_plan_evaluate': {
      const evaluation = parseEvaluationPayload(payload)
      if (!evaluation) return null
      return (
        <EvaluationCard
          complexity={evaluation.complexity}
          needsBreakdown={evaluation.needsBreakdown}
          confidence={evaluation.confidence}
          reasoning={evaluation.reasoning}
        />
      )
    }
    case 'breakdown': {
      const breakdown = parseBreakdownPayload(payload)
      if (!breakdown) return null
      return (
        <BreakdownCard
          proposed={breakdown.proposed}
          accepted={breakdown.accepted}
          rejected={breakdown.rejected}
        />
      )
    }
    case 'ai_review':
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return null
      }
      {
        const review = parseReviewPayload(payload)
        return (
          <ReviewResultCard
            approved={review.approved}
            feedback={review.feedback}
            taskId={review.taskId}
            tool={review.tool}
            checks={review.checks}
            findings={review.findings}
          />
        )
      }
    case 'memory_search':
    case 'memory_query':
      return <MemoryResult payload={payload} />
    case 'project_status':
      return <ProjectStatusResult payload={payload} />
    default:
      return null
  }
}

export function ToolCallCard({
  name,
  args,
  result,
  toolUseId,
  showPhaseActions = false,
  onAction,
  actionsDisabled = false,
  actionMessageId,
}: Props) {
  const normalizedName = normalizeToolName(name)
  const label = toolLabel(normalizedName)
  const rawResult = result?.content ?? ''
  const payloadForTool = parseToolResultPayload(normalizedName, rawResult)
  const richResult =
    result && !result.isError
      ? renderRichResult(normalizedName, payloadForTool)
      : null
  const phaseActionSet =
    result && !result.isError
      ? detectPhaseActions(normalizedName, payloadForTool)
      : null
  const hasRichResult = richResult !== null
  const isPending = !result

  return (
    <div className="w-full max-w-[92%] rounded-lg border border-border-subtle bg-surface-alt/60 px-3 py-2 text-xs">
      <div className="flex items-center gap-2">
        {isPending ? (
          <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-accent border-t-transparent" />
        ) : null}
        <span className="font-medium text-foreground">{label}</span>
        {result?.isError ? (
          <span className="text-[11px] text-danger">failed</span>
        ) : null}
      </div>

      {richResult ? <div className="mt-2">{richResult}</div> : null}

      {showPhaseActions && phaseActionSet && onAction ? (
        <ActionButtons
          phaseActions={phaseActionSet.actions}
          messageId={actionMessageId ?? toolUseId}
          disabled={actionsDisabled}
          onAction={onAction}
        />
      ) : null}

      {result?.isError ? (
        <pre className="mt-2 max-h-40 overflow-auto rounded bg-surface px-2 py-2 font-mono text-[11px] leading-5 text-danger whitespace-pre-wrap break-words">
          {rawResult || '(error)'}
        </pre>
      ) : null}

      {!hasRichResult && result && !result.isError && rawResult ? (
        <details className="mt-2">
          <summary className="cursor-pointer text-[11px] text-muted hover:text-foreground">
            Show details
          </summary>
          <pre className="mt-1 max-h-40 overflow-auto rounded bg-surface px-2 py-2 font-mono text-[11px] leading-5 whitespace-pre-wrap break-words">
            {toPrettyJSON(rawResult)}
          </pre>
        </details>
      ) : null}

      <details className="mt-1">
        <summary className="cursor-pointer text-[11px] text-muted hover:text-foreground">
          {normalizedName}
        </summary>
        <pre className="mt-1 max-h-32 overflow-auto rounded bg-surface px-2 py-2 font-mono text-[11px] leading-5 whitespace-pre-wrap break-words">
          {toPrettyJSON(args)}
        </pre>
      </details>
    </div>
  )
}
