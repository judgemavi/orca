import { type FormEvent, useMemo, useState } from 'react'
import { Dialog, DialogClose, DialogContent } from '@tiny-bits/react-dialog'
import { useMutation } from '@tanstack/react-query'
import { api } from '../../api'
import { useCreateTaskForm } from '../../hooks/forms/useCreateTaskForm'
import { useTasksQuery } from '../../hooks/queries/useTasks'
import type { Config, Task } from '../../types'
import { ActionButton } from '../common/ActionButton'

interface Props {
  config: Config
  onClose: () => void
  onCreated: () => void
}

const controlClass =
  'w-full rounded-md border px-3 py-1.5 text-sm outline-none transition-colors focus:border-accent'

export function CreateTaskModal({
  config: _config,
  onClose,
  onCreated,
}: Props) {
  const createTaskMutation = useMutation({
    mutationFn: (data: Partial<Task>) => api.createTask(data),
  })
  const tasksQuery = useTasksQuery()
  const [error, setError] = useState('')

  const dependencyTasks = useMemo(
    () =>
      (tasksQuery.data?.tasks ?? []).filter(
        (task) => task.status === 'pending',
      ),
    [tasksQuery.data?.tasks],
  )

  const form = useCreateTaskForm({}, async (values) => {
    setError('')

    const created = await createTaskMutation.mutateAsync({
      title: values.title.trim(),
      description: values.description.trim(),
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

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    try {
      await form.handleSubmit()
    } catch (err: any) {
      setError(err?.message ?? 'Failed to create task')
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="z-100 m-0! flex! h-screen! w-screen! items-center! justify-center! overflow-y-auto! bg-black/60! p-4! backdrop-blur-sm!">
        <div className="max-h-[90vh] w-120 max-w-[95vw] overflow-y-auto rounded-xl bg-surface-elevated text-foreground shadow-[0_16px_48px_rgba(0,0,0,0.3)]">
          <div className="flex items-center justify-between px-5 py-4">
            <h2 className="text-base font-semibold">New Task</h2>
            <DialogClose
              className="rounded px-1.5 py-1 text-sm"
              aria-label="Close"
              type="button"
            >
              ✕
            </DialogClose>
          </div>

          <form className="flex flex-col gap-4 p-4" onSubmit={handleSubmit}>
            <form.Field name="title">
              {(field) => (
                <label className="flex flex-col gap-2 text-xs font-medium">
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
                <label className="flex flex-col gap-2 text-xs font-medium">
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

            {dependencyTasks.length > 0 && (
              <form.Field name="dependencies">
                {(field) => (
                  <div className="flex flex-col gap-2 text-xs font-medium">
                    Dependencies
                    <div className="max-h-[140px] overflow-y-auto rounded-md border border-border-subtle bg-surface-alt px-3 py-1.5">
                      {dependencyTasks.map((task) => (
                        <label
                          key={task.id}
                          className="flex cursor-pointer items-center gap-2 py-1 "
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
                          <span className="flex-1 truncate text-xs">
                            {task.title}
                          </span>
                          <span className="font-mono text-xs">
                            {task.id.slice(0, 8)}
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}
              </form.Field>
            )}

            {error && <p className="text-xs">{error}</p>}

            <div className="flex justify-end gap-2 pt-4">
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
      </DialogContent>
    </Dialog>
  )
}
