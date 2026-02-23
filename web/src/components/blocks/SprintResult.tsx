import type { TaskResultSummary } from '../../types'
import { StatusIcon } from '../common/StatusBadge'
import { ToolChip } from '../common/ToolChip'
import { ActionButton } from '../common/ActionButton'

interface Props {
  data: { sprint_id: string; results: TaskResultSummary[]; actions: string[] }
  onAction?: (action: string) => void
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m${s % 60}s`
}

export function SprintResult({ data, onAction }: Props) {
  const results = data?.results ?? []
  const actions = data?.actions ?? []
  const succeeded = results.filter((r) => r.status === 'approved').length
  const failed = results.filter((r) => r.status === 'failed').length

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-slate-700 bg-slate-900 p-4">
      <div className="text-sm font-semibold">
        Sprint Complete: {succeeded} succeeded, {failed} failed
      </div>
      <div className="flex flex-col gap-3">
        {results.map((r) => (
          <div
            key={r.task_id}
            className="flex flex-col gap-1 border-l-2 border-slate-700 pl-2"
          >
            <div className="flex items-center gap-2">
              <StatusIcon status={r.status} />
              <span className="flex-1 text-[13px] font-medium">{r.title}</span>
              <ToolChip tool={r.tool_name} />
              <span className="font-mono text-xs text-slate-400">
                {formatDuration(r.duration_ms ?? 0)}
              </span>
            </div>
            {(r.files_changed ?? []).length > 0 && (
              <div className="font-mono text-xs text-slate-400">
                files: {(r.files_changed ?? []).join(', ')}
              </div>
            )}
            {r.diff_preview && (
              <div className="font-mono text-xs text-emerald-500">
                {r.diff_preview}
              </div>
            )}
            {r.has_full_diff && (
              <div className="flex justify-end">
                <ActionButton
                  label="Diff"
                  onClick={() => onAction?.(`diff ${r.task_id}`)}
                />
              </div>
            )}
          </div>
        ))}
      </div>
      {actions.length > 0 && (
        <div className="flex justify-end gap-2">
          {actions.map((a) => (
            <ActionButton
              key={a}
              label={a}
              variant={a.toLowerCase() === 'merge' ? 'primary' : 'default'}
              onClick={() => onAction?.(a)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
