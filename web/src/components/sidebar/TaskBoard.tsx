import { useState, useEffect } from 'react'
import type { Task } from '../../types'
import { StatusIcon } from '../common/StatusBadge'
import { ToolChip } from '../common/ToolChip'
import { api } from '../../api'

interface Props {
  refreshKey: number
}

const STATUS_ORDER = [
  'running',
  'in_sprint',
  'pending',
  'completed',
  'merged',
  'failed',
] as const

export function TaskBoard({ refreshKey }: Props) {
  const [tasks, setTasks] = useState<Task[]>([])
  const [expanded, setExpanded] = useState(true)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!expanded) return
    api
      .listTasks()
      .then((res) => {
        setTasks(res.tasks ?? [])
        setLoaded(true)
      })
      .catch(() => setLoaded(true))
  }, [expanded, refreshKey])

  const grouped = STATUS_ORDER.reduce<Record<string, Task[]>>((acc, s) => {
    const matching = tasks.filter((t) => t.status === s)
    if (matching.length > 0) acc[s] = matching
    return acc
  }, {})

  return (
    <div className="flex flex-col">
      <button
        className="flex cursor-pointer items-center gap-1.5 bg-transparent py-2 text-xs font-semibold uppercase tracking-[0.05em] text-slate-400"
        onClick={() => setExpanded(!expanded)}
        type="button"
      >
        <span className="text-[8px]">{expanded ? '\u25BC' : '\u25B6'}</span>
        Tasks ({tasks.length})
      </button>
      {expanded && loaded && (
        <div className="flex flex-col gap-0.5">
          {Object.entries(grouped).map(([status, items]) => (
            <div key={status}>
              {items.map((task) => (
                <div
                  key={task.id}
                  className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-black/10"
                >
                  <StatusIcon status={task.status} />
                  <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                    {task.title}
                  </span>
                  {task.assigned_tool && <ToolChip tool={task.assigned_tool} />}
                </div>
              ))}
            </div>
          ))}
          {tasks.length === 0 && (
            <div className="px-2 py-2 text-xs text-slate-400">No tasks</div>
          )}
        </div>
      )}
    </div>
  )
}
