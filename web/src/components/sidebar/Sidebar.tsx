import { useState, useEffect } from 'react'
import { PanelLeftClose, PanelLeft } from 'lucide-react'
import { TaskBoard } from './TaskBoard'
import { SprintTimeline } from './SprintTimeline'
import { api } from '../../api'

interface Props {
  collapsed: boolean
  onToggle: () => void
  refreshKey: number
}

export function Sidebar({ collapsed, onToggle, refreshKey }: Props) {
  const [cost, setCost] = useState<number | null>(null)

  useEffect(() => {
    api
      .getStatus()
      .then((status) => setCost(status.total_cost))
      .catch(() => {})
  }, [refreshKey])

  if (collapsed) {
    return (
      <div className="flex h-full w-12 shrink-0 flex-col items-center border-r border-slate-700 bg-slate-900 pt-3">
        <button
          className="flex h-7 w-7 items-center justify-center rounded-md text-slate-400 hover:bg-black/10 hover:text-slate-100"
          onClick={onToggle}
          type="button"
        >
          <PanelLeft size={18} />
        </button>
      </div>
    )
  }

  return (
    <div className="flex h-full w-[260px] shrink-0 flex-col border-r border-slate-700 bg-slate-900">
      <div className="flex items-center justify-between border-b border-slate-700 px-4 py-3">
        <span className="text-lg font-extrabold tracking-tight">Orca</span>
        <button
          className="flex h-7 w-7 items-center justify-center rounded-md text-slate-400 hover:bg-black/10 hover:text-slate-100"
          onClick={onToggle}
          type="button"
        >
          <PanelLeftClose size={18} />
        </button>
      </div>
      <div className="flex flex-1 flex-col gap-1 overflow-y-auto px-4 py-2">
        <TaskBoard refreshKey={refreshKey} />
        <SprintTimeline refreshKey={refreshKey} />
      </div>
      {cost !== null && (
        <div className="border-t border-slate-700 px-4 py-3">
          <span className="font-mono text-[13px] font-semibold text-slate-400">
            ${cost.toFixed(2)}
          </span>
        </div>
      )}
    </div>
  )
}
