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
import { CreateTaskModal } from './CreateTaskModal'
import { TaskDetailModal } from './task-detail/TaskDetailModal'
import { ReviewPanel } from './ReviewPanel'
import { Toast } from '../common/Toast'
import { useTasksQuery } from '../../hooks/queries/useTasks'
import { useActiveSprintQuery } from '../../hooks/queries/useSprints'
import { useModelsQuery } from '../../hooks/queries/useModels'
import { useConfigQuery } from '../../hooks/queries/useConfig'
import { useOperationsQuery } from '../../hooks/queries/useOperations'
import { BoardHeader } from './BoardHeader'
import { BoardColumn } from './BoardColumn'

const COLUMNS: { id: Task['status']; label: string }[] = [
  { id: 'pending', label: 'Pending' },
  { id: 'in_sprint', label: 'In Sprint' },
  { id: 'running', label: 'Running' },
  { id: 'review', label: 'Review' },
  { id: 'completed', label: 'Completed' },
  { id: 'merged', label: 'Merged' },
  { id: 'failed', label: 'Failed' },
]

interface Props {
  lastWSEvent: WSEvent | null
}

interface DraggableTaskCardWithModelsProps {
  task: Task
  onClick: () => void
  onRefresh: () => void
}

function DraggableTaskCardWithModels({
  task,
  onClick,
  onRefresh,
}: DraggableTaskCardWithModelsProps) {
  return (
    <DraggableTaskCard
      task={task}
      onClick={onClick}
      onRefresh={onRefresh}
    />
  )
}

interface DragOverlayTaskCardProps {
  task: Task
}

function DragOverlayTaskCard({ task }: DragOverlayTaskCardProps) {
  return <BoardTaskCard task={task} interactive={false} />
}

export function BoardView({ lastWSEvent }: Props) {
  const [actionLoading, setActionLoading] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [showReview, setShowReview] = useState(false)
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null)
  const [toastError, setToastError] = useState<string | null>(null)

  const queryClient = useQueryClient()
  const tasksQuery = useTasksQuery()
  const activeSprintQuery = useActiveSprintQuery()
  const configQuery = useConfigQuery()
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
  const loading =
    tasksQuery.isLoading ||
    activeSprintQuery.isLoading ||
    configQuery.isLoading ||
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
    const fromConfig = Object.keys(modelsByTool)
    const fromAssignedTools = tasks
      .map((t) => t.assigned_tool)
      .filter((t): t is string => Boolean(t))
    const fromPhaseConfig = tasks.flatMap((task) =>
      Object.values(task.phase_config?.phases ?? {})
        .map((phase) => phase.tool)
        .filter((tool): tool is string => Boolean(tool)),
    )
    return Array.from(
      new Set([...fromConfig, ...fromAssignedTools, ...fromPhaseConfig]),
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
      if (!COLUMNS.some((col) => col.id === targetCol)) return false
      if (task.status === targetCol) return true
      if (
        task.status === 'completed' ||
        task.status === 'merged' ||
        task.status === 'running' ||
        task.status === 'review'
      )
        return false
      if (
        targetCol === 'running' ||
        targetCol === 'completed' ||
        targetCol === 'review'
      )
        return false

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
    [sprint?.status, hasUnmetDependencies],
  )

  const runSprintAction = async (fn: () => Promise<unknown>) => {
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
    const task = tasks.find((t) => t.id === String(event.active.id))
    if (!task) return
    setActiveTaskId(task.id)
  }

  const handleDragEnd = async (event: DragEndEvent) => {
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
      task.status === 'running' ||
      task.status === 'review'
    )
      return
    if (
      targetCol === 'running' ||
      targetCol === 'completed' ||
      targetCol === 'review'
    )
      return

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
          showError(err?.message ?? 'Failed to move task to pending')
        }
      }
      return
    }
  }

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-border border-t-accent" />
      </div>
    )
  }

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
        <BoardHeader
          sprint={sprint}
          actionLoading={actionLoading}
          sprintStarting={sprintStarting}
          reviewRunning={reviewRunning}
          integrating={integrating}
          decomposeRunning={decomposeRunning}
          cleanupRunning={cleanupRunning}
          exploring={exploring}
          onPlanSprint={() => {
            void runSprintAction(() => api.planSprint())
          }}
          onStartSprint={(sprintId) => {
            void runSprintAction(() => api.startSprint(sprintId))
          }}
          onCancelSprint={(sprintId) => {
            void runSprintAction(() => api.cancelSprint(sprintId))
          }}
          onToggleReview={() => setShowReview((v) => !v)}
          onIntegrate={() => {
            void runSprintAction(() => api.integrate())
          }}
          onResetSprint={(sprintId) => {
            void runSprintAction(() => api.resetSprint(sprintId))
          }}
        />

        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <div className="flex flex-1 gap-0 overflow-x-auto overflow-y-hidden">
            {COLUMNS.map((col) => (
              <BoardColumn
                key={col.id}
                id={col.id}
                label={col.label}
                tasks={tasksByStatus[col.id] ?? []}
                activeTask={activeTask}
                canDrop={activeTask ? canDropTaskToColumn(activeTask, col.id) : true}
                onCreateTask={() => setShowCreate(true)}
                renderTask={(task) => (
                  <DraggableTaskCardWithModels
                    key={task.id}
                    task={task}
                    onClick={() => setSelectedTaskId(task.id)}
                    onRefresh={refreshAfterTaskUpdate}
                  />
                )}
              />
            ))}
          </div>

          <DragOverlay>
            {activeTask ? (
              <div className="w-[min(360px,calc(100vw-24px))]">
                <DragOverlayTaskCard task={activeTask} />
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

      {showCreate && configQuery.data && (
        <CreateTaskModal
          config={configQuery.data}
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false)
            void invalidateBoard()
          }}
        />
      )}

      {selectedTask && configQuery.data && (
        <TaskDetailModal
          task={selectedTask}
          tools={tools}
          config={configQuery.data}
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

      <Toast
        message={toastError}
        type="error"
        onClose={() => setToastError(null)}
      />
    </div>
  )
}
