import * as Dialog from '@radix-ui/react-dialog';
import { useMutation } from '@tanstack/react-query';
import { type FormEvent, useMemo, useState } from 'react';
import { api } from '../api';
import { useCreateTaskForm } from '../hooks/forms/useCreateTaskForm';
import { useConfigQuery, useTasksQuery } from '../hooks/queries';
import { type AutoRunOverrides, INTERACTION_TYPES, type Task } from '../types';
import { Button } from './Button';

const controlClass =
  'w-full rounded-md border px-3 py-1.5 text-sm outline-none transition-colors focus:border-accent';

export function CreateTaskModal() {
  const [open, setOpen] = useState(false);
  const createTaskMutation = useMutation({
    mutationFn: (data: Pick<Task, 'title'> & Partial<Task>) =>
      api.createTask(data),
  });
  const tasksQuery = useTasksQuery();
  const { data: config } = useConfigQuery();
  const [error, setError] = useState('');

  const dependencyTasks = useMemo(
    () => (tasksQuery.data ?? []).filter((task) => task.status === 'pending'),
    [tasksQuery.data],
  );

  const form = useCreateTaskForm({}, async (values) => {
    setError('');

    const overrides =
      Object.keys(values.autoRunOverrides).length > 0
        ? values.autoRunOverrides
        : undefined;
    const created = await createTaskMutation.mutateAsync({
      title: values.title.trim(),
      description: values.description.trim(),
      autoRunOverrides: overrides,
    });

    const taskId = created.id;
    if (taskId) {
      await Promise.all(
        values.dependencies.map((depId) =>
          api.addDependency(taskId, depId).catch(() => {}),
        ),
      );
    }
  });

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await form.handleSubmit();
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create task');
    }
  };

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
                                );
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

              <form.Field name="autoRunOverrides">
                {(field) => (
                  <details className="text-xs font-medium">
                    <summary className="cursor-pointer select-none py-1">
                      Auto-run overrides
                      {Object.keys(field.state.value).length > 0 && (
                        <span className="ml-1 text-muted">
                          ({Object.keys(field.state.value).length} customized)
                        </span>
                      )}
                    </summary>
                    <div className="mt-2 grid gap-1 rounded-md border px-3 py-2 sm:grid-cols-2">
                      {INTERACTION_TYPES.map((type) => {
                        const configDefault =
                          config?.interactions?.[type]?.autoRun ?? true;
                        const overridden = type in field.state.value;
                        const checked = overridden
                          ? Boolean(field.state.value[type])
                          : configDefault;
                        return (
                          <label
                            key={type}
                            className="flex items-center gap-2 py-0.5 text-[13px]"
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(e) => {
                                const next = {
                                  ...field.state.value,
                                } as AutoRunOverrides;
                                if (e.target.checked === configDefault) {
                                  delete next[type];
                                } else {
                                  next[type] = e.target.checked;
                                }
                                field.handleChange(next);
                              }}
                            />
                            <span className={overridden ? 'font-medium' : ''}>
                              {type}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                    <p className="mt-1 text-[11px] text-muted">
                      Toggle to override auto-run for this task. Bold = differs
                      from config default.
                    </p>
                  </details>
                )}
              </form.Field>

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
  );
}
