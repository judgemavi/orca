import { createFileRoute } from '@tanstack/react-router'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'
import * as Collapsible from '@radix-ui/react-collapsible'
import { api } from '../api'
import { InteractionLogPanel } from '../components/board/task-detail/InteractionLogPanel'
import { TaskActionsBar } from '../components/board/task-detail/TaskActionsBar'
import { TaskTimeline } from '../components/board/task-detail/TaskTimeline'
import { StatusBadge } from '../components/common/StatusBadge'
import {
  TaskDetailProvider,
  useTaskDetailContext,
} from '../context/TaskDetailContext'
import { useTaskForm } from '../hooks/forms/useTaskForm'
import { useConfigQuery } from '../hooks/queries/useConfig'
import { useModelsQuery } from '../hooks/queries/useModels'
import { useMutation } from '@tanstack/react-query'
import { useRunningOperations } from '../hooks/queries/useRunningOperations'
import { useTasksQuery } from '../hooks/queries/useTasks'
import { controlClass } from '../lib/constants'
import type { Config, Task } from '../types'

function formatRelativeTime(iso: string) {
  const timestamp = Date.parse(iso)
  if (!Number.isFinite(timestamp)) return 'just now'

  const deltaSeconds = Math.round((timestamp - Date.now()) / 1000)
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  const ranges: Array<{ limit: number; unit: Intl.RelativeTimeFormatUnit; inSeconds: number }> =
    [
      { limit: 60, unit: 'second', inSeconds: 1 },
      { limit: 3600, unit: 'minute', inSeconds: 60 },
      { limit: 86400, unit: 'hour', inSeconds: 3600 },
      { limit: 604800, unit: 'day', inSeconds: 86400 },
      { limit: 2629800, unit: 'week', inSeconds: 604800 },
      { limit: 31557600, unit: 'month', inSeconds: 2629800 },
      { limit: Number.POSITIVE_INFINITY, unit: 'year', inSeconds: 31557600 },
    ]

  for (const range of ranges) {
    if (Math.abs(deltaSeconds) < range.limit) {
      return rtf.format(Math.round(deltaSeconds / range.inSeconds), range.unit)
    }
  }

  return 'just now'
}

export function TaskDetailPage() {
  const { taskId } = useParams({ from: '/$taskId' })
  const tasksQuery = useTasksQuery()
  const configQuery = useConfigQuery()
  const allModelsQuery = useModelsQuery()
  const { isRunning } = useRunningOperations()

  const tasks = tasksQuery.data?.tasks ?? []
  const configData = configQuery.data
  const modelsByTool = allModelsQuery.data ?? {}
  const loading =
    tasksQuery.isLoading || configQuery.isLoading || allModelsQuery.isLoading
  const tools = useMemo(() => {
    const fromConfig = Object.keys(modelsByTool)
    return Array.from(new Set(fromConfig)).sort((a, b) => a.localeCompare(b))
  }, [modelsByTool])

  const task = tasks.find((item) => item.id === taskId)

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-border border-t-accent" />
      </div>
    )
  }

  if (!task || !configData) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm">
        <span>Task not found.</span>
        <Link
          to="/"
          className="rounded border border-border-subtle px-3 py-1.5 "
        >
          Back to tasks
        </Link>
      </div>
    )
  }

  return (
    <TaskDetailContent
      task={task}
      tasks={tasks}
      configData={configData}
      tools={tools}
      isRunning={isRunning}
    />
  )
}

function TaskDetailContent({
  task,
  tasks,
  configData,
  tools,
  isRunning,
}: {
  task: Task
  tasks: Task[]
  configData: Config
  tools: string[]
  isRunning: (type: string, targetId?: string) => boolean
}) {
  const navigate = useNavigate()
  const updateTaskMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<Task> }) => api.updateTask(id, data),
  })
  const deleteMutation = useMutation({ mutationFn: (id: string) => api.deleteTask(id) })
  const [saving, setSaving] = useState(false)
  const [selectedDependencyId, setSelectedDependencyId] = useState('')
  const [addingDependency, setAddingDependency] = useState(false)
  const [dependencyError, setDependencyError] = useState<string | null>(null)

  const form = useTaskForm(
    {
      title: task.title,
      description: task.description ?? '',
    },
    async (values) => {
      setSaving(true)
      try {
        await updateTaskMutation.mutateAsync({
          id: task.id,
          data: {
            title: values.title.trim(),
            description: values.description.trim(),
          },
        })
      } catch (err: any) {
        alert(err?.message ?? 'Save failed')
      } finally {
        setSaving(false)
      }
    },
  )

  useEffect(() => {
    form.reset({
      title: task.title,
      description: task.description ?? '',
    })
  }, [task.id, task.title, task.description, form])

  const isEditable = task.status === 'pending'

  const tasksById = useMemo(
    () => new Map(tasks.map((item) => [item.id, item])),
    [tasks],
  )
  const dependencyChoices = useMemo(
    () =>
      tasks
        .filter(
          (candidate) =>
            candidate.id !== task.id &&
            !(task.depends_on ?? []).includes(candidate.id),
        )
        .sort((a, b) => a.title.localeCompare(b.title)),
    [task.depends_on, task.id, tasks],
  )

  const handleAddDependency = async () => {
    if (!selectedDependencyId) {
      setDependencyError('Select a task to add as a dependency.')
      return
    }
    setDependencyError(null)
    setAddingDependency(true)
    try {
      await api.addDependency(task.id, selectedDependencyId)
      setSelectedDependencyId('')
    } catch (err: any) {
      setDependencyError(err?.message ?? 'Failed to add dependency')
    } finally {
      setAddingDependency(false)
    }
  }

  const handleDelete = async () => {
    try {
      await deleteMutation.mutateAsync(task.id)
      void navigate({ to: '/' })
    } catch (err: any) {
      alert(err?.message ?? 'Delete failed')
    }
  }

  return (
    <TaskDetailProvider
      task={task}
      config={configData}
      tools={tools}
      isOperationRunning={isRunning}
    >
      <div className="flex flex-1 overflow-hidden">
        <div className="mx-auto flex w-full flex-1 flex-col overflow-hidden px-6 py-4">
          <div className="mb-3 flex items-center justify-between">
            <Link
              to="/"
              className="rounded border border-border-subtle px-3 py-1.5 text-xs font-medium "
            >
              ← Back to tasks
            </Link>
          </div>

          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl bg-surface shadow-elevated">
            <div className="shrink-0 px-4 pt-4">
              <TaskDetailForm
                form={form}
                isEditable={isEditable}
                task={task}
                tasksById={tasksById}
                dependencyChoices={dependencyChoices}
                selectedDependencyId={selectedDependencyId}
                setSelectedDependencyId={setSelectedDependencyId}
                addingDependency={addingDependency}
                dependencyError={dependencyError}
                setDependencyError={setDependencyError}
                handleAddDependency={handleAddDependency}
              />
            </div>

            <TaskTimelineLayout />

            <TaskActionsBar
              isEditable={task.status === 'pending'}
              isDeletable={
                task.status !== 'running' && task.status !== 'merged'
              }
              deleting={deleteMutation.isPending}
              saving={saving}
              formId="task-edit-form"
              form={form}
              onDelete={() => {
                void handleDelete()
              }}
              onClose={() => {
                void navigate({ to: '/' })
              }}
            />
          </div>
        </div>
      </div>
    </TaskDetailProvider>
  )
}

type TaskDetailFormProps = {
  form: ReturnType<typeof useTaskForm>
  isEditable: boolean
  task: Task
  tasksById: Map<string, Task>
  dependencyChoices: Task[]
  selectedDependencyId: string
  setSelectedDependencyId: (value: string) => void
  addingDependency: boolean
  dependencyError: string | null
  setDependencyError: (value: string | null) => void
  handleAddDependency: () => Promise<void>
}

function TaskDetailForm({
  form,
  isEditable,
  task,
  tasksById,
  dependencyChoices,
  selectedDependencyId,
  setSelectedDependencyId,
  addingDependency,
  dependencyError,
  setDependencyError,
  handleAddDependency,
}: TaskDetailFormProps) {
  const [isExpanded, setIsExpanded] = useState(isEditable)

  useEffect(() => {
    setIsExpanded(isEditable)
  }, [task.id, isEditable])

  const dependencies = task.depends_on ?? []
  const description = form.state.values.description.trim()
  const dependencyCount = dependencies.length

  return (
    <form
      id="task-edit-form"
      className="rounded-lg border border-border-subtle bg-surface"
      onSubmit={(e) => {
        e.preventDefault()
        void form.handleSubmit()
      }}
    >
      <Collapsible.Root open={isExpanded} onOpenChange={setIsExpanded}>
        <div className="px-3 py-2">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <StatusBadge status={task.status} size="lg" />
                <h1 className="truncate text-lg font-semibold leading-tight">
                  {form.state.values.title.trim() || task.title}
                </h1>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                <span className="font-mono text-[11px]">{task.id.slice(0, 8)}</span>
                <span>·</span>
                <span>{dependencyCount} dependencies</span>
                <span>·</span>
                <span>
                  {task.status} {formatRelativeTime(task.updated_at)}
                </span>
              </div>
              {!isExpanded && description && (
                <p className="mt-1 line-clamp-2 text-xs text-muted">{description}</p>
              )}
              {!isExpanded && dependencyCount > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {dependencies.map((depId) => {
                    const depTask = tasksById.get(depId)
                    return (
                      <span
                        key={depId}
                        className="inline-flex max-w-[220px] items-center gap-1 rounded bg-surface-alt px-1.5 py-0.5 text-[11px]"
                      >
                        <span className="truncate">{depTask?.title || 'Unknown task'}</span>
                        <span className="font-mono">{depId.slice(0, 6)}</span>
                      </span>
                    )
                  })}
                </div>
              )}
            </div>
            <Collapsible.Trigger asChild>
              <button
                type="button"
                className="shrink-0 rounded border border-border-subtle px-2 py-1 text-xs font-medium"
              >
                {isExpanded ? 'Collapse' : isEditable ? 'Edit' : 'Expand'}
              </button>
            </Collapsible.Trigger>
          </div>
        </div>

        <Collapsible.Content className="border-t border-border-subtle px-3 py-3">
          <div className="flex flex-col gap-4">
            <form.Field name="title">
              {(field) => (
                <label className="flex flex-col gap-2 text-xs font-medium">
                  Title
                  {isEditable ? (
                    <input
                      className={controlClass}
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(e) => field.handleChange(e.target.value)}
                    />
                  ) : (
                    <div className="rounded-md bg-surface-alt px-3 py-1.5 text-sm font-normal">
                      {field.state.value || task.title}
                    </div>
                  )}
                </label>
              )}
            </form.Field>

            <form.Field name="description">
              {(field) => (
                <label className="flex flex-col gap-2 text-xs font-medium">
                  Description
                  {isEditable ? (
                    <textarea
                      className={controlClass}
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(e) => field.handleChange(e.target.value)}
                      rows={4}
                      placeholder="No description"
                    />
                  ) : (
                    <div className="min-h-[80px] whitespace-pre-wrap rounded-md bg-surface-alt px-3 py-1.5 text-sm font-normal">
                      {field.state.value || 'No description'}
                    </div>
                  )}
                </label>
              )}
            </form.Field>

            <div className="flex flex-col gap-2 text-xs font-medium">
              Dependencies
              {dependencies.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {dependencies.map((depId) => {
                    const depTask = tasksById.get(depId)
                    return (
                      <span
                        key={depId}
                        className="inline-flex items-center gap-2 rounded bg-surface-alt px-2 py-0.5 text-xs"
                      >
                        <span className="max-w-[280px] truncate">
                          {depTask?.title || 'Unknown task'}
                        </span>
                        <span className="font-mono">{depId.slice(0, 8)}</span>
                      </span>
                    )
                  })}
                </div>
              ) : (
                <p className="text-xs font-normal">No dependencies</p>
              )}
              {isEditable && (
                <div className="mt-1 flex flex-col gap-2">
                  {dependencyChoices.length > 0 ? (
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                      <select
                        className={controlClass}
                        value={selectedDependencyId}
                        onChange={(e) => {
                          setSelectedDependencyId(e.target.value)
                          if (dependencyError) setDependencyError(null)
                        }}
                        disabled={addingDependency}
                      >
                        <option value="">Select task dependency...</option>
                        {dependencyChoices.map((choice) => (
                          <option key={choice.id} value={choice.id}>
                            {choice.title} ({choice.id.slice(0, 8)})
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="rounded-md border border-border-subtle px-3 py-1.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-60"
                        onClick={() => {
                          void handleAddDependency()
                        }}
                        disabled={addingDependency || !selectedDependencyId}
                      >
                        {addingDependency ? 'Adding…' : 'Add Dependency'}
                      </button>
                    </div>
                  ) : (
                    <p className="text-xs font-normal">No available tasks to add.</p>
                  )}
                  {dependencyError && <p className="text-xs font-normal">{dependencyError}</p>}
                </div>
              )}
            </div>
          </div>
        </Collapsible.Content>
      </Collapsible.Root>
    </form>
  )
}

function TaskTimelineLayout() {
  const { activeLogId, task, setActiveLogId } = useTaskDetailContext()

  return (
    <div className="min-h-0 flex-1 p-4">
      <TaskTimeline>
        {activeLogId && (
          <div className="min-h-0 w-2/5 shrink-0">
            <InteractionLogPanel
              taskId={task.id}
              interactionId={activeLogId}
              onClose={() => {
                setActiveLogId(null)
              }}
            />
          </div>
        )}
      </TaskTimeline>
    </div>
  )
}
export const Route = createFileRoute('/$taskId')({
  component: TaskDetailPage,
})
