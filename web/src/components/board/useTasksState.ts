import { useState, useCallback, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../api'
import {
  useRunTasksMutation,
  useTasksQuery,
} from '../../hooks/queries/useTasks'
import { useModelsQuery } from '../../hooks/queries/useModels'
import { useConfigQuery } from '../../hooks/queries/useConfig'
import { useOperationsQuery } from '../../hooks/queries/useOperations'

export function useTasksState() {
  const [actionLoading, setActionLoading] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [showReview, setShowReview] = useState(false)
  const [toastError, setToastError] = useState<string | null>(null)

  const queryClient = useQueryClient()
  const tasksQuery = useTasksQuery()
  const runTasksMutation = useRunTasksMutation()
  const configQuery = useConfigQuery()
  const allModelsQuery = useModelsQuery()
  const operationsQuery = useOperationsQuery()
  const statusQuery = useQuery({
    queryKey: ['status'],
    queryFn: () => api.getStatus(),
  })

  const tasks = tasksQuery.data?.tasks ?? []
  const operations = operationsQuery.data?.operations ?? []
  const modelsByTool = allModelsQuery.data ?? {}
  const loading =
    tasksQuery.isLoading ||
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

  const showError = useCallback((message: string) => {
    setToastError(message)
  }, [])

  const invalidateBoard = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['tasks'] }),
      queryClient.invalidateQueries({ queryKey: ['operations'] }),
      queryClient.invalidateQueries({ queryKey: ['status'] }),
    ])
  }, [queryClient])

  const selectedTask = useMemo(
    () => tasks.find((task) => task.id === selectedTaskId) ?? null,
    [tasks, selectedTaskId],
  )

  const runAction = async (fn: () => Promise<unknown>) => {
    setActionLoading(true)
    try {
      await fn()
      await invalidateBoard()
    } catch (err: any) {
      showError(err?.message ?? 'Action failed')
    } finally {
      setActionLoading(false)
    }
  }

  const runTasks = async (taskIds?: string[]) => {
    await runAction(async () => {
      await runTasksMutation.mutateAsync(taskIds)
    })
  }

  const reviewTasks = useMemo(
    () => tasks.filter((task) => task.status === 'review' || task.status === 'failed'),
    [tasks],
  )

  const approvedTasks = useMemo(
    () => tasks.filter((task) => task.status === 'approved'),
    [tasks],
  )

  return {
    actionLoading,
    showCreate,
    setShowCreate,
    selectedTaskId,
    setSelectedTaskId,
    showReview,
    setShowReview,
    toastError,
    setToastError,

    tasks,
    configData: configQuery.data,
    loading,

    reviewTasks,
    approvedTasks,
    selectedTask,
    tools,
    isRunning,

    invalidateBoard,
    runTasks,
  }
}
