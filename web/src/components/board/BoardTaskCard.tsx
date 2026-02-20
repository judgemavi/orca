import { useState } from 'react'
import type { Task, ModelInfo } from '../../types'
import { api } from '../../api'

interface Props {
  task: Task
  tools?: string[]
  models?: ModelInfo[]
  loadingModels?: boolean
  onClick?: () => void
  onRefresh?: () => void
  className?: string
  interactive?: boolean
}

export function BoardTaskCard({
  task,
  tools = ['claude', 'codex', 'aider'],
  models = [],
  loadingModels = false,
  onClick,
  onRefresh,
  className,
  interactive = true,
}: Props) {
  const [saving, setSaving] = useState(false)

  const handleToolChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    e.stopPropagation()
    if (!onRefresh) return
    const nextTool = e.target.value || null
    setSaving(true)
    try {
      await api.updateTask(task.id, {
        assigned_tool: nextTool,
        model: null,
      } as any)
      onRefresh()
    } catch (err) {
      console.error('Update tool failed:', err)
    } finally {
      setSaving(false)
    }
  }

  const handleModelChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    e.stopPropagation()
    if (!onRefresh) return
    setSaving(true)
    try {
      await api.updateTask(task.id, { model: e.target.value || null } as any)
      onRefresh()
    } catch (err) {
      console.error('Update model failed:', err)
    } finally {
      setSaving(false)
    }
  }

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

  const toolColor = task.assigned_tool
    ? `var(--tool-${task.assigned_tool}, var(--text-secondary))`
    : 'var(--text-secondary)'

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
        <select
          className="min-w-0 flex-1 cursor-pointer rounded border border-border bg-[var(--bg-secondary)] px-1 py-0.5 font-mono text-[11px] focus:border-accent focus:outline-none"
          value={task.assigned_tool ?? ''}
          onChange={handleToolChange}
          onClick={(e) => e.stopPropagation()}
          disabled={saving || !interactive}
          style={{ color: toolColor }}
        >
          <option value="">— no tool</option>
          {tools.filter(Boolean).map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <select
          className="min-w-0 flex-1 cursor-pointer rounded border border-border bg-[var(--bg-secondary)] px-1 py-0.5 font-mono text-[11px] focus:border-accent focus:outline-none"
          value={task.model ?? ''}
          onChange={handleModelChange}
          onClick={(e) => e.stopPropagation()}
          disabled={
            saving || !interactive || !task.assigned_tool || loadingModels
          }
        >
          <option value="">— default model</option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>

        {(task.depends_on ?? []).length > 0 && (
          <span
            className="whitespace-nowrap rounded bg-[var(--bg-sidebar)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-secondary)]"
            title={`Depends on ${task.depends_on.length} task(s)`}
          >
            {task.depends_on.length} dep{task.depends_on.length > 1 ? 's' : ''}
          </span>
        )}
      </div>

      {interactive && (
        <div className="absolute right-2 top-1.5 hidden gap-1 group-hover:flex">
          {task.status === 'failed' && (
            <button
              className="rounded px-1 py-0.5 text-[11px] leading-none text-[var(--text-secondary)] hover:bg-[var(--bg-sidebar)] hover:text-[var(--status-failed)]"
              onClick={handleReopen}
              title="Reopen"
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
