import { type FormEvent, useMemo, useState } from 'react'
import { Dialog, DialogClose, DialogContent } from '@tiny-bits/react-dialog'
import { api } from '../../api'
import { useCreateTaskForm } from '../../hooks/forms/useCreateTaskForm'
import { useCreateTask, useTasksQuery } from '../../hooks/queries/useTasks'
import type { Config } from '../../types'
import { ActionButton } from '../common/ActionButton'
import { PhaseConfigFields } from './PhaseConfigFields'

interface Props {
  config: Config
  onClose: () => void
  onCreated: () => void
}

const controlClass =
  'w-full rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2.5 py-2 text-[13px] text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--accent)]'

type PhaseValues = Record<'plan' | 'sprint' | 'review', { tool: string; model: string }>

function buildDefaultPhaseValues(config: Config): PhaseValues {
  const tool = config.defaults?.tool ?? ''
  const model = config.defaults?.model ?? ''
  return {
    plan: { tool, model },
    sprint: { tool, model },
    review: { tool, model },
  }
}

function toPhaseOverride(value: { tool: string; model: string }) {
  const patch: { tool?: string; model?: string } = {}
  if (value.tool) patch.tool = value.tool
  if (value.model) patch.model = value.model
  return patch
}

export function CreateTaskModal({ config, onClose, onCreated }: Props) {
  const createTaskMutation = useCreateTask()
  const tasksQuery = useTasksQuery()
  const [error, setError] = useState('')
  const toolOptions = useMemo(
    () =>
      Object.keys(config.tools)
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b)),
    [config.tools],
  )

  const dependencyTasks = useMemo(
    () =>
      (tasksQuery.data?.tasks ?? []).filter(
        (task) => task.status === 'pending',
      ),
    [tasksQuery.data?.tasks],
  )

  const form = useCreateTaskForm(
    {
      useDefaults: true,
      phases: buildDefaultPhaseValues(config),
    },
    async (values) => {
      setError('')
      const sprintPhase = values.phases.sprint
      const compatTool = values.useDefaults
        ? (config.defaults?.tool ?? '')
        : (sprintPhase.tool || config.defaults?.tool || '')
      const compatModel = values.useDefaults
        ? (config.defaults?.model ?? '')
        : (sprintPhase.model || config.defaults?.model || '')

      const phaseConfig = values.useDefaults
        ? { use_defaults: true }
        : {
            use_defaults: false,
            phases: {
              plan: toPhaseOverride(values.phases.plan),
              sprint: toPhaseOverride(values.phases.sprint),
              review: toPhaseOverride(values.phases.review),
            },
          }

      const created = await createTaskMutation.mutateAsync({
        title: values.title.trim(),
        description: values.description.trim(),
        assigned_tool: compatTool || undefined,
        model: compatModel || undefined,
        phase_config: phaseConfig,
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
    },
  )

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
      <DialogContent className="z-[100] m-0! flex max-h-[90vh] w-[480px] max-w-[95vw] flex-col overflow-y-auto rounded-[var(--radius)] border! border-[var(--border)]! bg-[var(--bg-primary)]! text-[var(--text-primary)] p-0! shadow-[0_8px_32px_rgba(0,0,0,0.16)]">
        <div className="flex items-center justify-between border-b border-[var(--border)] px-5 py-4">
          <h2 className="text-[15px] font-semibold">New Task</h2>
          <DialogClose
            className="rounded px-1.5 py-1 text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]"
            aria-label="Close"
            type="button"
          >
            ✕
          </DialogClose>
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

          <form.Field name="useDefaults">
            {(field) => (
              <div className="flex flex-col gap-2">
                <label className="flex items-center gap-2 text-xs font-medium text-[var(--text-secondary)]">
                  <input
                    type="checkbox"
                    checked={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(e) => {
                      const checked = e.target.checked
                      field.handleChange(checked)
                      if (!checked) {
                        form.setFieldValue('phases', buildDefaultPhaseValues(config))
                      }
                    }}
                  />
                  Use configured defaults
                </label>

                {field.state.value ? (
                  <p className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-xs text-[var(--text-secondary)]">
                    Using configured defaults
                  </p>
                ) : (
                  <form.Field name="phases">
                    {(phaseField) => (
                      <PhaseConfigFields
                        tools={toolOptions}
                        config={config}
                        phases={phaseField.state.value}
                        onChange={(nextPhases) =>
                          phaseField.handleChange(nextPhases as any)
                        }
                        controlClass={controlClass}
                      />
                    )}
                  </form.Field>
                )}
              </div>
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
      </DialogContent>
    </Dialog>
  )
}
