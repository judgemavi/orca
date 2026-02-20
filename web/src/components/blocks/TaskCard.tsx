import { useState } from 'react'
import type { Task } from '../../types'
import { StatusIcon } from '../common/StatusBadge'
import { ToolChip } from '../common/ToolChip'
import { ActionButton } from '../common/ActionButton'

interface Props {
  data: { task: Task; actions: string[] }
  onAction?: (action: string) => void
}

export function TaskCard({ data, onAction }: Props) {
  const task = data?.task
  const actions = data?.actions ?? []
  const [expanded, setExpanded] = useState(false)

  if (!task) return null

  const depsOn = task.depends_on ?? []

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-slate-700 bg-slate-900 p-4">
      <div className="flex items-center gap-2">
        <StatusIcon status={task.status} />
        <span className="flex-1 text-sm font-semibold">{task.title}</span>
        {task.assigned_tool && <ToolChip tool={task.assigned_tool} />}
      </div>
      <div
        className={`cursor-pointer text-[13px] leading-6 text-slate-400 ${expanded ? '' : 'line-clamp-2'}`}
        onClick={() => setExpanded(!expanded)}
      >
        {task.description}
      </div>
      {depsOn.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 text-xs text-slate-400">
          depends on:{' '}
          {depsOn.map((id) => (
            <span
              key={id}
              className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[11px]"
            >
              {id.slice(0, 8)}
            </span>
          ))}
        </div>
      )}
      {actions.length > 0 && (
        <div className="mt-1 flex justify-end gap-2">
          {actions.map((a) => (
            <ActionButton key={a} label={a} onClick={() => onAction?.(a)} />
          ))}
        </div>
      )}
    </div>
  )
}
