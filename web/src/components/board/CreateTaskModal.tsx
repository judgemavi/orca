import { type FormEvent, useMemo, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { useMutation } from '@tanstack/react-query'
import { api } from '../../api'
import { useCreateTaskForm } from '../../hooks/forms/useCreateTaskForm'
import { useTasksQuery } from '../../hooks/queries'
import type { Task } from '../../types'
import { Button } from '../Button'

const controlClass =
  'w-full rounded-md border px-3 py-1.5 text-sm outline-none transition-colors focus:border-accent'

export function CreateTaskModal() {
  const [open, setOpen] = useState(false)
  const createTaskMutation = useMutation({
    mutationFn: (data: Partial<Task>) => api.createTask(data),
  })
  const tasksQuery = useTasksQuery()
  const [error, setError] = useState('')

  const dependencyTasks = useMemo(
    () => (tasksQuery.data ?? []).filter((task) => task.status === 'pending'),
    [tasksQuery.data],
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
  })

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    try {
      await form.handleSubmit()
      setOpen(false)
    } catch (err: any) {
      setError(err?.message ?? 'Failed to create task')
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <Button variant="primary">Create Task</Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content className="dialog-content fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2">
          <div className="dialog-content-inner w-md">
            <div className="flex items-center justify-between px-5 py-4">
              <Dialog.Title className="text-base font-semibold">
                New Task
              </Dialog.Title>
              <Dialog.Close
                className="rounded px-1.5 py-1 text-sm"
                aria-label="Close"
              >
                ✕
              </Dialog.Close>
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
                <Dialog.Close asChild>
                  <Button variant="default">Cancel</Button>
                </Dialog.Close>

                <Button
                  variant="primary"
                  type="submit"
                  disabled={createTaskMutation.isPending}
                >
                  {createTaskMutation.isPending ? 'Creating…' : 'Create Task'}
                </Button>
              </div>
            </form>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
