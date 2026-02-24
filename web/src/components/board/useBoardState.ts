import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Task, Sprint } from '../../types'
import { api } from '../../api'
import { useTasksQuery } from '../../hooks/queries/useTasks'
import { useActiveSprintQuery } from '../../hooks/queries/useSprints'
import { useModelsQuery } from '../../hooks/queries/useModels'
import { useConfigQuery } from '../../hooks/queries/useConfig'
import { useOperationsQuery } from '../../hooks/queries/useOperations'
import { ALL_STATUS_IDS } from './BoardColumns'

export function useBoardState() {
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
    const acc: Record<string, Task[]> = {}
    for (const status of ALL_STATUS_IDS) {
      acc[status] = tasks.filter((t) => t.status === status)
    }
    return acc
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
          dependency.status !== 'approved' &&
          dependency.status !== 'merged'
        )
      })
    },
    [taskMap],
  )

  const canDropTaskToColumn = useCallback(
    (task: Task, targetCol: string) => {
      if (!ALL_STATUS_IDS.includes(targetCol as Task['status'])) return false
      if (task.status === targetCol) return true
      if (
        task.status === 'approved' ||
        task.status === 'merged' ||
        task.status === 'running' ||
        task.status === 'review'
      )
        return false
      if (
        targetCol === 'running' ||
        targetCol === 'approved' ||
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
    if (!ALL_STATUS_IDS.includes(targetCol as Task['status'])) return
    if (task.status === targetCol) return

    if (
      task.status === 'approved' ||
      task.status === 'merged' ||
      task.status === 'running' ||
      task.status === 'review'
    )
      return
    if (
      targetCol === 'running' ||
      targetCol === 'approved' ||
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

  return {
    // State + setters
    actionLoading,
    showCreate,
    setShowCreate,
    selectedTaskId,
    setSelectedTaskId,
    showReview,
    setShowReview,
    toastError,
    setToastError,

    // Query data
    sprint,
    configData: configQuery.data,
    loading,

    // Derived state
    tasksByStatus,
    activeTask,
    selectedTask,
    tools,
    isRunning,
    sensors,
    canDropTaskToColumn,

    // Actions
    invalidateBoard,
    refreshAfterTaskUpdate,
    runSprintAction,
    handleDragStart,
    handleDragEnd,
  }
}
