import type { SprintTaskStatus } from '../../types'
import { StatusIcon } from '../common/StatusBadge'
import { ToolChip } from '../common/ToolChip'

interface Props {
  data: { sprint_id: string; tasks: SprintTaskStatus[] }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m${s % 60}s`
}

export function SprintProgress({ data }: Props) {
  const sprint_id = data?.sprint_id ?? ''
  const tasks = data?.tasks ?? []

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-slate-700 bg-slate-900 p-4">
      <div className="text-sm font-semibold">
        Sprint{' '}
        <span className="font-mono text-[13px] text-slate-400">
          {sprint_id.slice(0, 8)}
        </span>{' '}
        — Running
      </div>
      <div className="flex flex-col gap-3">
        {tasks.map((task) => (
          <div key={task.task_id} className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <StatusIcon status={task.status} />
              <span className="flex-1 text-[13px] font-medium">
                {task.title}
              </span>
              <ToolChip tool={task.tool_name} />
            </div>
            <div className="flex items-center gap-2">
              <div className="h-1.5 flex-1 overflow-hidden rounded bg-slate-800">
                <div
                  className="h-full rounded transition-[width] duration-300"
                  style={{
                    width: `${Math.min(task.progress_pct ?? 0, 99)}%`,
                    background:
                      task.status === 'completed'
                        ? 'var(--status-completed)'
                        : task.status === 'failed'
                          ? 'var(--status-failed)'
                          : 'var(--status-running)',
                  }}
                />
              </div>
              <span className="min-w-9 text-right font-mono text-xs text-slate-400">
                {task.status === 'completed'
                  ? 'done'
                  : `${Math.min(task.progress_pct ?? 0, 99)}%`}
              </span>
              <span className="min-w-12 text-right font-mono text-xs text-slate-400">
                {formatDuration(task.duration_ms ?? 0)}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
