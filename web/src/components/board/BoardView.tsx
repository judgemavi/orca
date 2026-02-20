import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Task, Sprint, WSEvent } from '../../types'
import { api } from '../../api'
import { BoardTaskCard } from './BoardTaskCard'
import { DraggableTaskCard } from './DraggableTaskCard'
import { DroppableColumn } from './DroppableColumn'
import { CreateTaskModal } from './CreateTaskModal'
import { TaskDetailModal } from './TaskDetailModal'
import { ReviewPanel } from './ReviewPanel'
import { AutopilotDialog } from './AutopilotDialog'
import { AutopilotProgress } from './AutopilotProgress'
import { AutopilotConfirmDialog } from './AutopilotConfirmDialog'
import { ActionButton } from '../common/ActionButton'
import { StatusBadge } from '../common/StatusBadge'
import { OperationsIndicator } from '../common/OperationsIndicator'
import { Toast } from '../common/Toast'
import { useTasksQuery } from '../../hooks/queries/useTasks'
import { useActiveSprintQuery } from '../../hooks/queries/useSprints'
import { useModelsQuery } from '../../hooks/queries/useModels'
import { useOperationsQuery } from '../../hooks/queries/useOperations'
import type { AutopilotEvent } from '../../hooks/useAutopilot'

const COLUMNS: { id: Task['status']; label: string }[] = [
  { id: 'pending', label: 'Backlog' },
  { id: 'in_sprint', label: 'In Sprint' },
  { id: 'running', label: 'Running' },
  { id: 'completed', label: 'Completed' },
  { id: 'merged', label: 'Merged' },
  { id: 'failed', label: 'Failed' },
]

const TOOL_FALLBACKS = ['claude', 'codex', 'aider']

interface Props {
  lastWSEvent: WSEvent | null
  autopilotRunning: boolean
  autopilotGoal: string
  autopilotEvents: AutopilotEvent[]
  autopilotPendingConfirm: string | null
  onAutopilotStart: (
    goal: string,
    opts: { unattended: boolean; maxSprints: number },
  ) => Promise<void>
  onAutopilotStop: () => Promise<void>
  onAutopilotRespond: (cont: boolean) => Promise<void>
}

interface DraggableTaskCardWithModelsProps {
  task: Task
  tools: string[]
  onClick: () => void
  onRefresh: () => void
}

function DraggableTaskCardWithModels({
  task,
  tools,
  onClick,
  onRefresh,
}: DraggableTaskCardWithModelsProps) {
  const tool = task.assigned_tool ?? undefined
  const modelsQuery = useModelsQuery(tool)
  const models = tool ? (modelsQuery.data?.[tool] ?? []) : []

  return (
    <DraggableTaskCard
      task={task}
      tools={tools}
      models={models}
      loadingModels={Boolean(tool) && modelsQuery.isFetching}
      onClick={onClick}
      onRefresh={onRefresh}
    />
  )
}

interface DragOverlayTaskCardProps {
  task: Task
  tools: string[]
}

function DragOverlayTaskCard({ task, tools }: DragOverlayTaskCardProps) {
  const tool = task.assigned_tool ?? undefined
  const modelsQuery = useModelsQuery(tool)
  const models = tool ? (modelsQuery.data?.[tool] ?? []) : []

  return (
    <BoardTaskCard
      task={task}
      tools={tools}
      models={models}
      loadingModels={Boolean(tool) && modelsQuery.isFetching}
      interactive={false}
    />
  )
}

function badgeColorClass(status: Task['status']) {
  if (status === 'running') return 'bg-blue-500/15 text-[var(--status-running)]'
  if (status === 'completed')
    return 'bg-green-500/15 text-[var(--status-completed)]'
  if (status === 'merged')
    return 'bg-emerald-500/15 text-[var(--status-merged)]'
  if (status === 'failed') return 'bg-red-500/15 text-[var(--status-failed)]'
  if (status === 'in_sprint')
    return 'bg-violet-400/15 text-[var(--status-in_sprint)]'
  return 'bg-[var(--bg-sidebar)] text-[var(--text-secondary)]'
}

export function BoardView({
  lastWSEvent,
  autopilotRunning,
  autopilotGoal,
  autopilotEvents,
  autopilotPendingConfirm,
  onAutopilotStart,
  onAutopilotStop,
  onAutopilotRespond,
}: Props) {
  const [actionLoading, setActionLoading] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [showReview, setShowReview] = useState(false)
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null)
  const [toastError, setToastError] = useState<string | null>(null)
  const [showAutopilotStart, setShowAutopilotStart] = useState(false)

  const queryClient = useQueryClient()
  const tasksQuery = useTasksQuery()
  const activeSprintQuery = useActiveSprintQuery()
  const allModelsQuery = useModelsQuery()
  const operationsQuery = useOperationsQuery()
  const statusQuery = useQuery({
    queryKey: ['status'],
    queryFn: () => api.getStatus(),
  })

  const tasks = tasksQuery.data?.tasks ?? []
  const sprint = activeSprintQuery.data as Sprint | null
  const operations = operationsQuery.data?.operations ?? []
  const modelsByTool = allModelsQuery.data ?? {}
  const budget =
    typeof statusQuery.data?.budget === 'number' ? statusQuery.data.budget : 0

  const loading =
    tasksQuery.isLoading ||
    activeSprintQuery.isLoading ||
    allModelsQuery.isLoading ||
    statusQuery.isLoading

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

  const tools = useMemo(() => {
    const discovered = Object.keys(modelsByTool)
    const fromTasks = tasks
      .map((task) => task.assigned_tool)
      .filter((tool): tool is string => Boolean(tool && tool.length > 0))
    return Array.from(
      new Set([...TOOL_FALLBACKS, ...discovered, ...fromTasks]),
    ).sort((a, b) => a.localeCompare(b))
  }, [modelsByTool, tasks])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  )

  const showError = useCallback((message: string) => {
    setToastError(message)
  }, [])

  const invalidateBoard = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['tasks'] }),
      queryClient.invalidateQueries({ queryKey: ['sprints'] }),
      queryClient.invalidateQueries({ queryKey: ['sprint', 'active'] }),
      queryClient.invalidateQueries({ queryKey: ['operations'] }),
      queryClient.invalidateQueries({ queryKey: ['status'] }),
    ])
  }, [queryClient])

  const refreshAfterTaskUpdate = useCallback(() => {
    void invalidateBoard()
  }, [invalidateBoard])

  useEffect(() => {
    if (sprint && sprint.status !== 'completed' && sprint.status !== 'failed') {
      setShowReview(false)
    }
  }, [sprint?.status])

  const taskMap = useMemo(() => {
    return new Map(tasks.map((task) => [task.id, task]))
  }, [tasks])

  const tasksByStatus = useMemo(() => {
    return COLUMNS.reduce<Record<string, Task[]>>((acc, col) => {
      acc[col.id] = tasks.filter((t) => t.status === col.id)
      return acc
    }, {})
  }, [tasks])

  const activeTask = useMemo(
    () => tasks.find((task) => task.id === activeTaskId) ?? null,
    [tasks, activeTaskId],
  )

  const selectedTask = useMemo(
    () => tasks.find((task) => task.id === selectedTaskId) ?? null,
    [tasks, selectedTaskId],
  )

  const hasUnmetDependencies = useCallback(
    (task: Task) => {
      const dependencies = task.depends_on ?? []
      return dependencies.some((depId) => {
        const dependency = taskMap.get(depId)
        if (!dependency) return true
        const inSprint =
          dependency.status === 'in_sprint' || dependency.status === 'running'
        return (
          !inSprint &&
          dependency.status !== 'completed' &&
          dependency.status !== 'merged'
        )
      })
    },
    [taskMap],
  )

  const canDropTaskToColumn = useCallback(
    (task: Task, targetCol: string) => {
      if (autopilotRunning) return false
      if (!COLUMNS.some((col) => col.id === targetCol)) return false
      if (task.status === targetCol) return true
      if (
        task.status === 'completed' ||
        task.status === 'merged' ||
        task.status === 'running'
      )
        return false
      if (targetCol === 'running' || targetCol === 'completed') return false

      if (targetCol === 'in_sprint') {
        if (sprint?.status === 'running') return false
        if (task.status !== 'pending' && task.status !== 'failed') return false
        return !hasUnmetDependencies(task)
      }

      if (targetCol === 'pending') {
        if (task.status === 'in_sprint') return sprint?.status === 'planning'
        if (task.status === 'failed') return true
        return false
      }

      return false
    },
    [autopilotRunning, sprint?.status, hasUnmetDependencies],
  )

  const runSprintAction = async (fn: () => Promise<unknown>) => {
    if (autopilotRunning) return
    setActionLoading(true)
    try {
      await fn()
      await invalidateBoard()
    } catch (err: any) {
      showError(err?.message ?? 'Sprint action failed')
    } finally {
      setActionLoading(false)
    }
  }

  const handleDragStart = (event: DragStartEvent) => {
    if (autopilotRunning) return
    const task = tasks.find((t) => t.id === String(event.active.id))
    if (!task) return
    setActiveTaskId(task.id)
  }

  const handleDragEnd = async (event: DragEndEvent) => {
    if (autopilotRunning) {
      setActiveTaskId(null)
      return
    }
    const { active, over } = event
    setActiveTaskId(null)
    if (!over) return

    const task = tasks.find((t) => t.id === String(active.id))
    if (!task) return

    const targetCol = String(over.id)
    if (!COLUMNS.some((col) => col.id === targetCol)) return
    if (task.status === targetCol) return

    if (
      task.status === 'completed' ||
      task.status === 'merged' ||
      task.status === 'running'
    )
      return
    if (targetCol === 'running' || targetCol === 'completed') return

    if (targetCol === 'in_sprint') {
      if (sprint?.status === 'running') {
        showError('Cannot add tasks while sprint is running')
        return
      }
      if (hasUnmetDependencies(task)) {
        showError('Cannot add task to sprint: unmet dependencies')
        return
      }
      try {
        await api.sprintAssign(task.id, sprint?.id)
        await invalidateBoard()
      } catch (err: any) {
        showError(err?.message ?? 'Failed to assign task to sprint')
      }
      return
    }

    if (targetCol === 'pending') {
      if (task.status === 'in_sprint') {
        if (sprint?.status !== 'planning') {
          showError('Cannot remove tasks from running sprint')
          return
        }
        try {
          await api.sprintUnassign(task.id)
          await invalidateBoard()
        } catch (err: any) {
          showError(err?.message ?? 'Failed to remove task from sprint')
        }
      } else if (task.status === 'failed') {
        try {
          await api.updateTask(task.id, { status: 'pending' } as any)
          await invalidateBoard()
        } catch (err: any) {
          showError(err?.message ?? 'Failed to move task to backlog')
        }
      }
      return
    }
  }

  const handleAutopilotStart = async (
    goal: string,
    opts: { unattended: boolean; maxSprints: number },
  ) => {
    try {
      await onAutopilotStart(goal, opts)
      setShowAutopilotStart(false)
    } catch (err: any) {
      showError(err?.message ?? 'Failed to start autopilot')
    }
  }

  const handleAutopilotStop = async () => {
    try {
      await onAutopilotStop()
    } catch (err: any) {
      showError(err?.message ?? 'Failed to stop autopilot')
    }
  }

  const handleAutopilotRespond = async (cont: boolean) => {
    try {
      await onAutopilotRespond(cont)
    } catch (err: any) {
      showError(err?.message ?? 'Failed to respond to autopilot')
    }
  }

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-border border-t-accent" />
      </div>
    )
  }

  const sprintTaskCount = sprint ? (sprint.task_ids ?? []).length : 0
  const activeSprintId = sprint?.id ?? ''
  const sprintStarting =
    activeSprintId !== '' && isRunning('sprint_start', activeSprintId)
  const reviewRunning =
    activeSprintId !== '' && isRunning('review', activeSprintId)
  const integrating = isRunning('integrate')
  const decomposeRunning = isRunning('decompose')
  const cleanupRunning = isRunning('cleanup')
  const exploring = isRunning('explore')

  return (
    <div className="flex flex-1 overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {autopilotRunning && (
          <AutopilotProgress
            goal={autopilotGoal}
            events={autopilotEvents}
            onStop={handleAutopilotStop}
          />
        )}
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-4 border-b border-border bg-[var(--bg-secondary)] px-4 py-2.5 max-[960px]:items-start">
          <div className="flex items-center gap-3">
            <ActionButton variant="primary" onClick={() => setShowCreate(true)}>
              + New Task
            </ActionButton>
            <span className="text-xs text-[var(--text-secondary)]">
              {tasks.length} task{tasks.length !== 1 ? 's' : ''}
            </span>
            {(decomposeRunning || cleanupRunning || exploring) && (
              <span className="text-xs text-accent">
                {decomposeRunning && 'Decomposing... '}
                {cleanupRunning && 'Cleaning... '}
                {exploring && 'Exploring...'}
              </span>
            )}
          </div>

          <div className="ml-auto flex flex-wrap items-center gap-3 max-[960px]:ml-0 max-[960px]:w-full max-[960px]:justify-between">
            {!autopilotRunning && (
              <ActionButton
                variant="primary"
                onClick={() => setShowAutopilotStart(true)}
              >
                Autopilot
              </ActionButton>
            )}

            <div className="flex items-center gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--text-secondary)]">
                Sprint:
              </span>
              {sprint ? (
                <>
                  <span className="font-mono text-xs text-[var(--text-primary)]">
                    {sprint.id.slice(0, 8)}
                  </span>
                  <StatusBadge status={sprint.status} />
                  <span className="text-xs text-[var(--text-secondary)]">
                    {sprintTaskCount} task{sprintTaskCount !== 1 ? 's' : ''}
                  </span>
                </>
              ) : (
                <span className="text-xs italic text-[var(--text-secondary)]">
                  none
                </span>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {!sprint && (
                <ActionButton
                  variant="primary"
                  onClick={() => runSprintAction(() => api.planSprint())}
                  disabled={actionLoading || autopilotRunning}
                >
                  Plan Sprint
                </ActionButton>
              )}

              {sprint?.status === 'planning' && (
                <>
                  <ActionButton
                    variant="primary"
                    onClick={() =>
                      runSprintAction(() => api.startSprint(sprint.id))
                    }
                    disabled={
                      actionLoading || autopilotRunning || sprintStarting
                    }
                  >
                    {sprintStarting ? 'Starting...' : 'Start'}
                  </ActionButton>
                  <ActionButton
                    variant="danger"
                    onClick={() =>
                      runSprintAction(() => api.cancelSprint(sprint.id))
                    }
                    disabled={actionLoading || autopilotRunning}
                  >
                    Cancel
                  </ActionButton>
                </>
              )}

              {sprint?.status === 'running' && (
                <ActionButton
                  variant="danger"
                  onClick={() =>
                    runSprintAction(() => api.cancelSprint(sprint.id))
                  }
                  disabled={actionLoading || autopilotRunning}
                >
                  Cancel
                </ActionButton>
              )}

              {(sprint?.status === 'completed' ||
                sprint?.status === 'failed') && (
                <>
                  <ActionButton
                    variant="default"
                    onClick={() => setShowReview((v) => !v)}
                    disabled={autopilotRunning || reviewRunning}
                  >
                    {reviewRunning ? 'Reviewing...' : 'Review'}
                  </ActionButton>
                  <ActionButton
                    variant="primary"
                    onClick={() => runSprintAction(() => api.integrate())}
                    disabled={actionLoading || autopilotRunning || integrating}
                  >
                    {integrating ? 'Integrating...' : 'Integrate'}
                  </ActionButton>
                  <ActionButton
                    variant="default"
                    onClick={() =>
                      runSprintAction(() => api.resetSprint(sprint.id))
                    }
                    disabled={actionLoading || autopilotRunning}
                  >
                    Reset
                  </ActionButton>
                </>
              )}
            </div>
            <OperationsIndicator />
          </div>
        </div>

        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <div className="flex flex-1 gap-0 overflow-x-auto overflow-y-hidden">
            {COLUMNS.map((col) => {
              const colTasks = tasksByStatus[col.id] ?? []
              const canDrop = activeTask
                ? canDropTaskToColumn(activeTask, col.id)
                : true

              return (
                <DroppableColumn
                  key={col.id}
                  id={col.id}
                  className={[
                    'flex min-w-[200px] flex-1 flex-col overflow-hidden border-r border-border last:border-r-0',
                    col.id === 'completed'
                      ? '[&_[data-col-cards]]:opacity-80'
                      : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  activeDrag={
                    Boolean(activeTask) && activeTask?.status !== col.id
                  }
                  canDrop={canDrop}
                >
                  <div className="flex shrink-0 items-center justify-between border-b border-border bg-[var(--bg-secondary)] px-3 py-2">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--text-secondary)]">
                      {col.label}
                    </span>
                    <span
                      className={[
                        'rounded-[10px] px-1.5 py-px font-mono text-[11px] font-semibold',
                        badgeColorClass(col.id),
                      ].join(' ')}
                    >
                      {colTasks.length}
                    </span>
                  </div>
                  <div
                    data-col-cards
                    className="flex flex-1 flex-col gap-2 overflow-y-auto px-2 py-2.5"
                  >
                    {colTasks.map((task) => (
                      <DraggableTaskCardWithModels
                        key={task.id}
                        task={task}
                        tools={tools}
                        onClick={() => setSelectedTaskId(task.id)}
                        onRefresh={refreshAfterTaskUpdate}
                      />
                    ))}
                    {colTasks.length === 0 && (
                      <div className="py-5 text-center text-[13px] text-[var(--text-secondary)] opacity-40">
                        -
                      </div>
                    )}
                  </div>
                </DroppableColumn>
              )
            })}
          </div>

          <DragOverlay>
            {activeTask ? (
              <div className="w-[min(360px,calc(100vw-24px))]">
                <DragOverlayTaskCard task={activeTask} tools={tools} />
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      </div>

      {showReview &&
        sprint &&
        (sprint.status === 'completed' || sprint.status === 'failed') && (
          <ReviewPanel
            sprint={sprint}
            onClose={() => setShowReview(false)}
            onIntegrated={() => {
              setShowReview(false)
              void invalidateBoard()
            }}
          />
        )}

      {showCreate && (
        <CreateTaskModal
          tools={tools}
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false)
            void invalidateBoard()
          }}
        />
      )}

      {selectedTask && (
        <TaskDetailModal
          task={selectedTask}
          tools={tools}
          sprintId={sprint?.id}
          lastWSEvent={lastWSEvent}
          isOperationRunning={isRunning}
          onClose={() => setSelectedTaskId(null)}
          onSaved={() => {
            void invalidateBoard()
          }}
          onDeleted={() => {
            setSelectedTaskId(null)
            void invalidateBoard()
          }}
        />
      )}

      <AutopilotDialog
        open={showAutopilotStart}
        budget={budget}
        onStart={handleAutopilotStart}
        onClose={() => setShowAutopilotStart(false)}
      />

      <AutopilotConfirmDialog
        open={Boolean(autopilotPendingConfirm)}
        message={autopilotPendingConfirm ?? ''}
        onContinue={() => handleAutopilotRespond(true)}
        onAbort={() => handleAutopilotRespond(false)}
      />

      <Toast
        message={toastError}
        type="error"
        onClose={() => setToastError(null)}
      />
    </div>
  )
}
