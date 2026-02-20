import { useState, useEffect } from 'react'
import type { Sprint } from '../../types'
import { StatusBadge } from '../common/StatusBadge'
import { api } from '../../api'

interface Props {
  refreshKey: number
}

export function SprintTimeline({ refreshKey }: Props) {
  const [sprint, setSprint] = useState<Sprint | null>(null)
  const [expanded, setExpanded] = useState(true)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!expanded) return
    api
      .getActiveSprint()
      .then((res) => {
        setSprint(res as Sprint | null)
        setLoaded(true)
      })
      .catch(() => setLoaded(true))
  }, [expanded, refreshKey])

  return (
    <div className="flex flex-col">
      <button
        className="flex cursor-pointer items-center gap-1.5 bg-transparent py-2 text-xs font-semibold uppercase tracking-[0.05em] text-slate-400"
        onClick={() => setExpanded(!expanded)}
        type="button"
      >
        <span className="text-[8px]">{expanded ? '\u25BC' : '\u25B6'}</span>
        Sprints
      </button>
      {expanded && loaded && (
        <div className="flex flex-col gap-1">
          {sprint ? (
            <div className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px]">
              <span className="font-mono text-xs text-slate-400">
                {sprint.id.slice(0, 8)}
              </span>
              <StatusBadge status={sprint.status} />
              <span className="text-xs text-slate-400">
                {(sprint.task_ids ?? []).length} tasks
              </span>
            </div>
          ) : (
            <div className="px-2 py-2 text-xs text-slate-400">
              No active sprint
            </div>
          )}
        </div>
      )}
    </div>
  )
}
