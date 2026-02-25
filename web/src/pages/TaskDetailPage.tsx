import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { api } from '../api'
import { InteractionLogPanel } from '../components/board/task-detail/InteractionLogPanel'
import { TaskActionsBar } from '../components/board/task-detail/TaskActionsBar'
import { TaskTimeline as TaskTimelineBase } from '../components/board/task-detail/TaskTimeline'
import { useTasksState } from '../components/board/useTasksState'
import { StatusBadge } from '../components/common/StatusBadge'
import {
  TaskDetailProvider,
  useTaskDetailContext,
} from '../context/TaskDetailContext'
import { useLastWSEvent } from '../context/ws'
import type { Config, Task } from '../types'

export function TaskDetailPage() {
  const { taskId } = useParams({ from: '/tasks/$taskId' })
  const {
    tasks,
    configData,
    loading,
    tools,
    isRunning,
    invalidateBoard,
  } = useTasksState()

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
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-[var(--text-secondary)]">
        <span>Task not found.</span>
        <Link
          to="/"
          className="rounded border border-border px-3 py-1.5 text-[var(--text-primary)] hover:bg-[var(--bg-secondary)]"
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
      invalidateBoard={invalidateBoard}
    />
  )
}

function TaskDetailContent({
  task,
  tasks,
  configData,
  tools,
  isRunning,
  invalidateBoard,
}: {
  task: Task
  tasks: Task[]
  configData: Config
  tools: string[]
  isRunning: (type: string, targetId?: string) => boolean
  invalidateBoard: () => Promise<void>
}) {
  const navigate = useNavigate()
  const lastWSEvent = useLastWSEvent()
  const [selectedDependencyId, setSelectedDependencyId] = useState('')
  const [addingDependency, setAddingDependency] = useState(false)
  const [dependencyError, setDependencyError] = useState<string | null>(null)

  const tasksById = useMemo(
    () => new Map(tasks.map((item) => [item.id, item])),
    [tasks],
  )
  const dependencyChoices = useMemo(
    () =>
      tasks
        .filter(
          (candidate) =>
            candidate.id !== task.id && !(task.depends_on ?? []).includes(candidate.id),
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
      await invalidateBoard()
    } catch (err: any) {
      setDependencyError(err?.message ?? 'Failed to add dependency')
    } finally {
      setAddingDependency(false)
    }
  }

  return (
    <TaskDetailProvider
      task={task}
      config={configData}
      tools={tools}
      lastWSEvent={lastWSEvent}
      isOperationRunning={isRunning}
      onSaved={() => {
        void invalidateBoard()
      }}
      onDeleted={() => {
        void navigate({ to: '/' })
        void invalidateBoard()
      }}
    >
      <div className="flex flex-1 overflow-hidden">
        <div className="mx-auto flex w-full flex-1 flex-col overflow-hidden px-4 py-4">
          <div className="mb-3 flex items-center justify-between">
            <Link
              to="/"
              className="rounded border border-border px-3 py-1.5 text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--bg-secondary)]"
            >
              ← Back to tasks
            </Link>
            <div className="flex items-center gap-2.5">
              <StatusBadge status={task.status} />
              <span className="font-mono text-[11px] text-[var(--text-secondary)]">
                {task.id.slice(0, 8)}
              </span>
            </div>
          </div>

          <div className="flex min-h-0 flex-1 flex-col overflow-auto rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-primary)]">
            <div className="flex flex-1 flex-col gap-3.5 p-5">
              <TaskDetailForm
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

            <TaskDetailActionsBar
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
  tasksById,
  dependencyChoices,
  selectedDependencyId,
  setSelectedDependencyId,
  addingDependency,
  dependencyError,
  setDependencyError,
  handleAddDependency,
}: TaskDetailFormProps) {
  const { form, isEditable, task, controlClass } = useTaskDetailContext()

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
            <label className="flex flex-col gap-1.5 text-xs font-medium text-[var(--text-secondary)]">
              Title
              {isEditable ? (
                <input
                  className={controlClass}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
              ) : (
                <div className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-2 text-[13px] font-normal text-[var(--text-primary)]">
                  {field.state.value || task.title}
                </div>
              )}
            </label>
          )}
        </form.Field>

        <form.Field name="description">
          {(field) => (
            <label className="flex flex-col gap-1.5 text-xs font-medium text-[var(--text-secondary)]">
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
                <div className="min-h-[80px] whitespace-pre-wrap rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-2 text-[13px] font-normal text-[var(--text-primary)]">
                  {field.state.value || 'No description'}
                </div>
              )}
            </label>
          )}
        </form.Field>

        <div className="flex flex-col gap-1.5 text-xs font-medium text-[var(--text-secondary)]">
          Dependencies
          {(task.depends_on ?? []).length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {(task.depends_on ?? []).map((depId) => {
                const depTask = tasksById.get(depId)
                return (
                  <span
                    key={depId}
                    className="inline-flex items-center gap-1.5 rounded border border-[var(--border)] bg-[var(--bg-sidebar)] px-1.5 py-0.5 text-[11px] text-[var(--text-secondary)]"
                  >
                    <span className="max-w-[280px] truncate text-[var(--text-primary)]">
                      {depTask?.title || 'Unknown task'}
                    </span>
                    <span className="font-mono">{depId.slice(0, 8)}</span>
                  </span>
                )
              })}
            </div>
          ) : (
            <p className="text-[12px] font-normal text-[var(--text-secondary)]">
              No dependencies
            </p>
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
                    className="rounded-md border border-[var(--border)] px-3 py-2 text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] disabled:cursor-not-allowed disabled:opacity-60"
                    onClick={() => {
                      void handleAddDependency()
                    }}
                    disabled={addingDependency || !selectedDependencyId}
                  >
                    {addingDependency ? 'Adding…' : 'Add Dependency'}
                  </button>
                </div>
              ) : (
                <p className="text-[12px] font-normal text-[var(--text-secondary)]">
                  No available tasks to add.
                </p>
              )}
              {dependencyError && (
                <p className="text-[12px] font-normal text-[var(--status-failed)]">
                  {dependencyError}
                </p>
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

function TaskTimeline() {
  return <TaskTimelineBase />
}

function TaskDetailActionsBar({ onClose }: { onClose: () => void }) {
  const {
    isEditable,
    isDeletable,
    deleting,
    saving,
    form,
    handleDelete,
  } = useTaskDetailContext()

  return (
    <TaskActionsBar
      isEditable={isEditable}
      isDeletable={isDeletable}
      deleting={deleting}
      saving={saving}
      formId="task-edit-form"
      form={form}
      onDelete={handleDelete}
      onClose={onClose}
    />
  )
}
