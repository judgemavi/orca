import { useNavigate } from '@tanstack/react-router'
import type { Task } from '../../types'

interface Props {
  tasks: Task[]
}

const STATUS_DOT: Record<Task['status'], string> = {
  pending: 'bg-slate-400',
  planned: 'bg-indigo-400',
  running: 'bg-blue-400',
  review: 'bg-amber-400',
  failed: 'bg-red-400',
  approved: 'bg-emerald-400',
  merged: 'bg-violet-400',
}

const STATUS_TEXT: Record<Task['status'], string> = {
  pending: 'text-slate-300',
  planned: 'text-indigo-300',
  running: 'text-blue-300',
  review: 'text-amber-300',
  failed: 'text-red-300',
  approved: 'text-emerald-300',
  merged: 'text-violet-300',
}

function formatRelativeTime(iso: string) {
  const timestamp = Date.parse(iso)
  if (!Number.isFinite(timestamp)) return 'just now'
  const deltaSeconds = Math.round((timestamp - Date.now()) / 1000)
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

  const intervals = [
    { unit: 'year', seconds: 60 * 60 * 24 * 365 },
    { unit: 'month', seconds: 60 * 60 * 24 * 30 },
    { unit: 'week', seconds: 60 * 60 * 24 * 7 },
    { unit: 'day', seconds: 60 * 60 * 24 },
    { unit: 'hour', seconds: 60 * 60 },
    { unit: 'minute', seconds: 60 },
  ] as const

  for (const interval of intervals) {
    if (Math.abs(deltaSeconds) >= interval.seconds) {
      return rtf.format(
        Math.round(deltaSeconds / interval.seconds),
        interval.unit,
      )
    }
  }

  return rtf.format(deltaSeconds, 'second')
}

function getTaskTool(task: Task): string {
  const withTool = task as Task & {
    tool?: string
    last_tool?: string
    suggested_tool?: string
  }
  return withTool.tool || withTool.last_tool || withTool.suggested_tool || 'auto'
}

function formatTaskCost(task: Task): string {
  const withCost = task as Task & {
    estimated_cost?: number
    total_cost?: number
    cost?: number
  }
  const value = withCost.cost ?? withCost.total_cost ?? withCost.estimated_cost
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `$${value.toFixed(2)}`
  }
  return '-'
}

export function TasksTable({ tasks }: Props) {
  const navigate = useNavigate()

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="min-h-0 flex-1 overflow-auto px-4 py-2">
        <div className="grid grid-cols-[minmax(0,1fr)_4.5rem_5.5rem] gap-2 border-b border-border-subtle px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-foreground/60 md:grid-cols-[minmax(0,1fr)_5.5rem_5.5rem_5.5rem_1rem]">
          <span>Task</span>
          <span className="hidden md:block">Tool</span>
          <span>Updated</span>
          <span className="hidden md:block">Cost</span>
          <span className="hidden md:block" />
        </div>

        <div className="space-y-0.5 pt-1">
          {tasks.map((task) => (
            <button
              key={task.id}
              type="button"
              className="group grid w-full cursor-pointer grid-cols-[minmax(0,1fr)_4.5rem_5.5rem] items-center gap-2 rounded-md px-2 py-1.5 text-left transition hover:bg-surface-alt md:grid-cols-[minmax(0,1fr)_5.5rem_5.5rem_5.5rem_1rem]"
              onClick={() => {
                void navigate({
                  to: '/$taskId',
                  params: { taskId: task.id },
                })
              }}
            >
              <span className="flex min-w-0 items-center gap-2">
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[task.status]}`}
                />
                <span
                  className={`shrink-0 text-[11px] font-medium capitalize ${STATUS_TEXT[task.status]}`}
                >
                  {task.status}
                </span>
                <span className="truncate text-sm">{task.title}</span>
              </span>
              <span className="hidden truncate text-xs text-foreground/70 md:block">
                {getTaskTool(task)}
              </span>
              <span className="truncate text-xs text-foreground/70">
                {formatRelativeTime(task.updated_at)}
              </span>
              <span className="hidden truncate text-xs text-foreground/70 md:block">
                {formatTaskCost(task)}
              </span>
              <span className="hidden text-foreground/40 opacity-0 transition group-hover:opacity-100 md:block">
                ›
              </span>
            </button>
          ))}
        </div>

        {tasks.length === 0 && (
          <div className="px-3 py-8 text-center text-sm text-foreground/70">
            No tasks match the current filters.
          </div>
        )}
      </div>
    </div>
  )
}
