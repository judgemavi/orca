import type { Task } from '../../types'
import { DroppableColumn } from './DroppableColumn'

interface Props {
  id: Task['status']
  label: string
  tasks: Task[]
  activeTask: Task | null
  canDrop: boolean
  onCreateTask: () => void
  renderTask: (task: Task) => React.ReactNode
}

function badgeColorClass(status: Task['status']) {
  if (status === 'running') return 'bg-blue-500/15 text-[var(--status-running)]'
  if (status === 'review') return 'bg-amber-500/15 text-amber-400'
  if (status === 'completed')
    return 'bg-green-500/15 text-[var(--status-completed)]'
  if (status === 'merged') return 'bg-emerald-500/15 text-[var(--status-merged)]'
  if (status === 'failed') return 'bg-red-500/15 text-[var(--status-failed)]'
  if (status === 'in_sprint')
    return 'bg-violet-400/15 text-[var(--status-in_sprint)]'
  return 'bg-[var(--bg-sidebar)] text-[var(--text-secondary)]'
}

export function BoardColumn({
  id,
  label,
  tasks,
  activeTask,
  canDrop,
  onCreateTask,
  renderTask,
}: Props) {
  return (
    <DroppableColumn
      id={id}
      className={[
        'flex min-w-[200px] flex-1 flex-col overflow-hidden border-r border-border last:border-r-0',
        id === 'completed' ? '[&_[data-col-cards]]:opacity-80' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      activeDrag={Boolean(activeTask) && activeTask?.status !== id}
      canDrop={canDrop}
    >
      <div className="flex shrink-0 items-center justify-between border-b border-border bg-[var(--bg-secondary)] px-3 py-2">
        {id === 'pending' ? (
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--text-secondary)]">
              {label}
            </span>
            <button
              onClick={onCreateTask}
              className="rounded px-1 py-px text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-sidebar)] hover:text-accent"
              title="New task"
            >
              + New
            </button>
          </div>
        ) : (
          <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--text-secondary)]">
            {label}
          </span>
        )}
        <span
          className={[
            'rounded-[10px] px-1.5 py-px font-mono text-[11px] font-semibold',
            badgeColorClass(id),
          ].join(' ')}
        >
          {tasks.length}
        </span>
      </div>
      <div
        data-col-cards
        className="flex flex-1 flex-col gap-2 overflow-y-auto px-2 py-2.5"
      >
        {tasks.map((task) => renderTask(task))}
        {tasks.length === 0 && (
          <div className="py-5 text-center text-[13px] text-[var(--text-secondary)] opacity-40">
            -
          </div>
        )}
      </div>
    </DroppableColumn>
  )
}
