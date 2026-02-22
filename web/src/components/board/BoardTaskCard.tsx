import { useState } from 'react'
import type { Task } from '../../types'
import { api } from '../../api'

interface Props {
  task: Task
  onClick?: () => void
  onRefresh?: () => void
  className?: string
  interactive?: boolean
}

export function BoardTaskCard({
  task,
  onClick,
  onRefresh,
  className,
  interactive = true,
}: Props) {
  const [saving, setSaving] = useState(false)
  const isEditable = task.status === 'pending' || task.status === 'failed'

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!onRefresh) return
    if (!confirm(`Delete "${task.title}"?`)) return
    try {
      await api.deleteTask(task.id)
      onRefresh()
    } catch (err) {
      console.error('Delete task failed:', err)
    }
  }

  const handleReopen = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!onRefresh || task.status !== 'failed') return
    setSaving(true)
    try {
      await api.reopenTask(task.id)
      onRefresh()
    } catch (err) {
      console.error('Reopen task failed:', err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className={[
        'group relative cursor-pointer rounded border border-border bg-[var(--bg-primary)] p-2.5 px-3 transition hover:border-accent hover:shadow-[0_2px_8px_rgba(0,0,0,0.08)]',
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
      onClick={onClick}
    >
      <div className="mb-2 flex items-start gap-2">
        <div className="line-clamp-2 flex-1 text-[13px] font-medium leading-[1.4] text-[var(--text-primary)]">
          {task.title}
        </div>
        {task.plan && (
          <span
            className="mt-px rounded border border-accent px-1 py-px font-mono text-[10px] leading-[1.2] text-accent"
            title="Task has a plan"
          >
            P
          </span>
        )}
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {(task.depends_on ?? []).length > 0 && (
          <span
            className="whitespace-nowrap rounded bg-[var(--bg-sidebar)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-secondary)]"
            title={`Depends on ${task.depends_on.length} task(s)`}
          >
            {task.depends_on.length} dep{task.depends_on.length > 1 ? 's' : ''}
          </span>
        )}
      </div>

      {interactive && isEditable && (
        <div className="absolute right-2 top-1.5 hidden gap-1 group-hover:flex">
          {task.status === 'failed' && (
            <button
              className="rounded px-1 py-0.5 text-[11px] leading-none text-[var(--text-secondary)] hover:bg-[var(--bg-sidebar)] hover:text-[var(--status-failed)]"
              onClick={handleReopen}
              title="Reopen"
              disabled={saving}
            >
              Reopen
            </button>
          )}
          <button
            className="rounded px-1 py-0.5 text-[11px] leading-none text-[var(--text-secondary)] hover:bg-[var(--bg-sidebar)] hover:text-[var(--status-failed)]"
            onClick={handleDelete}
            title="Delete"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  )
}
