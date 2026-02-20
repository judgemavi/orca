import { type FormEvent, useMemo, useState } from 'react'
import { api } from '../../api'
import { useCreateTaskForm } from '../../hooks/forms/useCreateTaskForm'
import { useModelsQuery } from '../../hooks/queries/useModels'
import { useCreateTask, useTasksQuery } from '../../hooks/queries/useTasks'
import { ActionButton } from '../common/ActionButton'

interface Props {
  tools: string[]
  onClose: () => void
  onCreated: () => void
}

const controlClass =
  'w-full rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2.5 py-2 text-[13px] text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--accent)]'

export function CreateTaskModal({ tools, onClose, onCreated }: Props) {
  const createTaskMutation = useCreateTask()
  const tasksQuery = useTasksQuery()
  const [error, setError] = useState('')
  const [selectedTool, setSelectedTool] = useState('')
  const modelsQuery = useModelsQuery(selectedTool || undefined)

  const dependencyTasks = useMemo(
    () =>
      (tasksQuery.data?.tasks ?? []).filter(
        (task) => task.status === 'pending',
      ),
    [tasksQuery.data?.tasks],
  )

  const form = useCreateTaskForm(undefined, async (values) => {
    setError('')
    const created = await createTaskMutation.mutateAsync({
      title: values.title.trim(),
      description: values.description.trim(),
      assigned_tool: values.tool || undefined,
      model: values.model || undefined,
    } as any)

    const taskId = (created as any).id ?? (created as any).task?.id
    if (taskId) {
      await Promise.all(
        values.dependencies.map((depId) =>
          api.addDependency(taskId, depId).catch(() => {}),
        ),
      )
    }
    onCreated()
  })

  const availableModels = selectedTool
    ? (modelsQuery.data?.[selectedTool] ?? [])
    : []

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    try {
      await form.handleSubmit()
    } catch (err: any) {
      setError(err?.message ?? 'Failed to create task')
    }
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="flex max-h-[90vh] w-[480px] max-w-[95vw] flex-col overflow-y-auto rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-primary)] shadow-[0_8px_32px_rgba(0,0,0,0.16)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--border)] px-5 py-4">
          <h2 className="text-[15px] font-semibold">New Task</h2>
          <button
            className="rounded px-1.5 py-1 text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]"
            onClick={onClose}
            type="button"
          >
            ✕
          </button>
        </div>

        <form className="flex flex-col gap-3.5 p-5" onSubmit={handleSubmit}>
          <form.Field name="title">
            {(field) => (
              <label className="flex flex-col gap-1.5 text-xs font-medium text-[var(--text-secondary)]">
                Title *
                <input
                  className={controlClass}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                  placeholder="e.g. Add user authentication"
                  autoFocus
                />
              </label>
            )}
          </form.Field>

          <form.Field name="description">
            {(field) => (
              <label className="flex flex-col gap-1.5 text-xs font-medium text-[var(--text-secondary)]">
                Description
                <textarea
                  className={controlClass}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                  placeholder="What needs to be implemented..."
                  rows={3}
                />
              </label>
            )}
          </form.Field>

          <form.Field name="tool">
            {(field) => (
              <label className="flex flex-col gap-1.5 text-xs font-medium text-[var(--text-secondary)]">
                Assigned Tool
                <select
                  className={controlClass}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => {
                    const nextTool = e.target.value
                    field.handleChange(nextTool)
                    form.setFieldValue('model', '')
                    setSelectedTool(nextTool)
                  }}
                >
                  <option value="">- no preference</option>
                  {tools.filter(Boolean).map((tool) => (
                    <option key={tool} value={tool}>
                      {tool}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </form.Field>

          <form.Field name="model">
            {(field) => (
              <label className="flex flex-col gap-1.5 text-xs font-medium text-[var(--text-secondary)]">
                Model
                <select
                  className={controlClass}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                  disabled={!selectedTool || modelsQuery.isFetching}
                >
                  <option value="">- default model</option>
                  {availableModels.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </form.Field>

          {dependencyTasks.length > 0 && (
            <form.Field name="dependencies">
              {(field) => (
                <div className="flex flex-col gap-1.5 text-xs font-medium text-[var(--text-secondary)]">
                  Dependencies
                  <div className="max-h-[140px] overflow-y-auto rounded-md border border-[var(--border)] px-2 py-1.5">
                    {dependencyTasks.map((task) => (
                      <label
                        key={task.id}
                        className="flex cursor-pointer items-center gap-2 py-1 hover:text-[var(--text-primary)]"
                      >
                        <input
                          type="checkbox"
                          checked={field.state.value.includes(task.id)}
                          onChange={() => {
                            field.handleChange(
                              field.state.value.includes(task.id)
                                ? field.state.value.filter(
                                    (depId) => depId !== task.id,
                                  )
                                : [...field.state.value, task.id],
                            )
                          }}
                        />
                        <span className="flex-1 truncate text-xs text-[var(--text-primary)]">
                          {task.title}
                        </span>
                        <span className="font-mono text-[10px] text-[var(--text-secondary)]">
                          {task.id.slice(0, 8)}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </form.Field>
          )}

          {error && (
            <p className="text-xs text-[var(--status-failed)]">{error}</p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <ActionButton variant="default" onClick={onClose} type="button">
              Cancel
            </ActionButton>
            <ActionButton
              variant="primary"
              type="submit"
              disabled={createTaskMutation.isPending}
            >
              {createTaskMutation.isPending ? 'Creating…' : 'Create Task'}
            </ActionButton>
          </div>
        </form>
      </div>
    </div>
  )
}
