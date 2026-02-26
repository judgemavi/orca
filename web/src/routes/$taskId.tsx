import { createFileRoute } from '@tanstack/react-router'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useState } from 'react'
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
import { useOperationsQuery } from '../hooks/queries/useOperations'
import {
  useDeleteTask,
  useTasksQuery,
  useUpdateTask,
} from '../hooks/queries/useTasks'
import { controlClass } from '../lib/constants'
import type { Config, Operation, Task } from '../types'

export function TaskDetailPage() {
  const { taskId } = useParams({ from: '/$taskId' })
  const tasksQuery = useTasksQuery()
  const configQuery = useConfigQuery()
  const allModelsQuery = useModelsQuery()
  const operationsQuery = useOperationsQuery()

  const tasks = tasksQuery.data?.tasks ?? []
  const configData = configQuery.data
  const operations = operationsQuery.data?.operations ?? []
  const modelsByTool = allModelsQuery.data ?? {}
  const loading =
    tasksQuery.isLoading || configQuery.isLoading || allModelsQuery.isLoading
  const tools = useMemo(() => {
    const fromConfig = Object.keys(modelsByTool)
    return Array.from(new Set(fromConfig)).sort((a, b) => a.localeCompare(b))
  }, [modelsByTool])
  const runningOperations = useMemo(
    () => operations.filter((op) => op.status === 'running'),
    [operations],
  )
  const isRunning = useCallback(
    (type: string, targetId?: string) => {
      return runningOperations.some(
        (op) =>
          op.type === type &&
          (targetId === undefined ||
            targetId === '' ||
            op.target_id === targetId),
      )
    },
    [runningOperations],
  )

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
        <Link to="/" className="rounded border border-border px-3 py-1.5 ">
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
      operations={operations}
      isRunning={isRunning}
    />
  )
}

function TaskDetailContent({
  task,
  tasks,
  configData,
  tools,
  operations,
  isRunning,
}: {
  task: Task
  tasks: Task[]
  configData: Config
  tools: string[]
  operations: Operation[]
  isRunning: (type: string, targetId?: string) => boolean
}) {
  const navigate = useNavigate()
  const updateTaskMutation = useUpdateTask()
  const deleteMutation = useDeleteTask()
  const [saving, setSaving] = useState(false)
  const [selectedDependencyId, setSelectedDependencyId] = useState('')
  const [addingDependency, setAddingDependency] = useState(false)
  const [dependencyError, setDependencyError] = useState<string | null>(null)

  const runningOperations = useMemo(
    () => operations.filter((op) => op.status === 'running'),
    [operations],
  )
  const isOperationRunning = useCallback(
    (type: string, targetId?: string) => {
      if (runningOperations.length === 0) return isRunning(type, targetId)
      return runningOperations.some(
        (op) =>
          op.type === type &&
          (targetId === undefined ||
            targetId === '' ||
            op.target_id === targetId),
      )
    },
    [isRunning, runningOperations],
  )

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
      isOperationRunning={isOperationRunning}
    >
      <div className="flex flex-1 overflow-hidden">
        <div className="mx-auto flex w-full flex-1 flex-col overflow-hidden px-4 py-4">
          <div className="mb-3 flex items-center justify-between">
            <Link
              to="/"
              className="rounded border border-border px-3 py-1.5 text-xs font-medium "
            >
              ← Back to tasks
            </Link>
            <div className="flex items-center gap-2.5">
              <StatusBadge status={task.status} />
              <span className="font-mono text-[11px]">
                {task.id.slice(0, 8)}
              </span>
            </div>
          </div>

          <div className="flex min-h-0 flex-1 flex-col overflow-auto rounded-lg border">
            <div className="flex flex-1 flex-col gap-3.5 p-5">
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

              <TaskTimelineLayout />
            </div>

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
  return (
    <form
      id="task-edit-form"
      onSubmit={(e) => {
        e.preventDefault()
        void form.handleSubmit()
      }}
    >
      <div className="flex flex-col gap-3.5">
        <form.Field name="title">
          {(field) => (
            <label className="flex flex-col gap-1.5 text-xs font-medium">
              Title
              {isEditable ? (
                <input
                  className={controlClass}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
              ) : (
                <div className="rounded-md border px-2.5 py-2 text-[13px] font-normal">
                  {field.state.value || task.title}
                </div>
              )}
            </label>
          )}
        </form.Field>

        <form.Field name="description">
          {(field) => (
            <label className="flex flex-col gap-1.5 text-xs font-medium">
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
                <div className="min-h-[80px] whitespace-pre-wrap rounded-md border px-2.5 py-2 text-[13px] font-normal">
                  {field.state.value || 'No description'}
                </div>
              )}
            </label>
          )}
        </form.Field>

        <div className="flex flex-col gap-1.5 text-xs font-medium">
          Dependencies
          {(task.depends_on ?? []).length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {(task.depends_on ?? []).map((depId) => {
                const depTask = tasksById.get(depId)
                return (
                  <span
                    key={depId}
                    className="inline-flex items-center gap-1.5 rounded border bg-surface px-1.5 py-0.5 text-[11px]"
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
            <p className="text-[12px] font-normal">No dependencies</p>
          )}
          {isEditable && (
            <div className="mt-1 flex flex-col gap-1.5">
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
                    className="rounded-md border px-3 py-2 text-xs font-medium  disabled:cursor-not-allowed disabled:opacity-60"
                    onClick={() => {
                      void handleAddDependency()
                    }}
                    disabled={addingDependency || !selectedDependencyId}
                  >
                    {addingDependency ? 'Adding…' : 'Add Dependency'}
                  </button>
                </div>
              ) : (
                <p className="text-[12px] font-normal">
                  No available tasks to add.
                </p>
              )}
              {dependencyError && (
                <p className="text-[12px] font-normal">{dependencyError}</p>
              )}
            </div>
          )}
        </div>
      </div>
    </form>
  )
}

function TaskTimelineLayout() {
  const { activeLogId, task, setActiveLogId } = useTaskDetailContext()

  return (
    <div className="flex min-h-[420px] flex-col gap-4 lg:flex-row">
      <div
        className={[
          'min-h-0 w-full transition-all duration-200',
          activeLogId ? 'lg:w-3/5' : 'lg:w-full',
        ].join(' ')}
      >
        <TaskTimeline />
      </div>

      {activeLogId && (
        <div className="min-h-0 w-full transform transition-all duration-200 ease-out lg:w-2/5">
          <InteractionLogPanel
            taskId={task.id}
            interactionId={activeLogId}
            onClose={() => {
              setActiveLogId(null)
            }}
          />
        </div>
      )}
    </div>
  )
}
export const Route = createFileRoute('/$taskId')({
  component: TaskDetailPage,
})
