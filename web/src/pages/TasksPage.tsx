import { useCallback, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { api } from '../api'
import { ReviewPanel } from '../components/board/ReviewPanel'
import { CreateTaskModal } from '../components/board/CreateTaskModal'
import { TasksTable } from '../components/board/TasksTable'
import { TasksToolbar } from '../components/board/TasksToolbar'
import { toast } from 'sonner'
import { useConfigQuery } from '../hooks/queries/useConfig'
import { useModelsQuery } from '../hooks/queries/useModels'
import { useOperationsQuery } from '../hooks/queries/useOperations'
import {
  useRunTasksMutation,
  useTasksQuery,
} from '../hooks/queries/useTasks'

export function TasksPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const tasksQuery = useTasksQuery()
  const configQuery = useConfigQuery()
  const allModelsQuery = useModelsQuery()
  const operationsQuery = useOperationsQuery()
  const runTasksMutation = useRunTasksMutation()

  const [showCreate, setShowCreate] = useState(false)
  const [showReview, setShowReview] = useState(false)

  const tasks = tasksQuery.data?.tasks ?? []
  const operations = operationsQuery.data?.operations ?? []
  const loading = tasksQuery.isLoading || configQuery.isLoading
  const configData = configQuery.data

  void allModelsQuery.data

  const runningOperations = useMemo(
    () => operations.filter((op) => op.status === 'running'),
    [operations],
  )

  const isRunning = useCallback(
    (type: string, targetId?: string) =>
      runningOperations.some(
        (op) =>
          op.type === type &&
          (targetId === undefined ||
            targetId === '' ||
            op.target_id === targetId),
      ),
    [runningOperations],
  )

  const reviewTasks = useMemo(
    () => tasks.filter((t) => t.status === 'review' || t.status === 'failed'),
    [tasks],
  )

  const approvedTasks = useMemo(
    () => tasks.filter((t) => t.status === 'approved'),
    [tasks],
  )

  const invalidateBoard = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['tasks'] }),
      queryClient.invalidateQueries({ queryKey: ['operations'] }),
      queryClient.invalidateQueries({ queryKey: ['status'] }),
    ])
  }, [queryClient])

  const runTasks = async (taskIds?: string[]) => {
    try {
      await runTasksMutation.mutateAsync(taskIds)
      await invalidateBoard()
    } catch (err: any) {
      toast.error(err?.message ?? 'Run failed')
    }
  }

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-border border-t-accent" />
      </div>
    )
  }

  const runPending = isRunning('run')
  const merging = isRunning('merge')
  const decomposeRunning = isRunning('decompose')
  const cleanupRunning = isRunning('cleanup')
  const exploring = isRunning('explore')

  return (
    <div className="flex flex-1 overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <TasksToolbar
          actionLoading={runTasksMutation.isPending}
          runPending={runPending}
          mergePending={merging}
          reviewOpen={showReview}
          hasReviewTasks={reviewTasks.length > 0}
          hasApprovedTasks={approvedTasks.length > 0}
          decomposeRunning={decomposeRunning}
          cleanupRunning={cleanupRunning}
          exploring={exploring}
          onRun={() => {
            void runTasks()
          }}
          onToggleReview={() => setShowReview((v) => !v)}
          onMerge={() => {
            void (async () => {
              try {
                await api.merge()
                await invalidateBoard()
              } catch (err: any) {
                toast.error(err?.message ?? 'Merge failed')
              }
            })()
          }}
          onCreateTask={() => setShowCreate(true)}
        />

        <TasksTable tasks={tasks} />
      </div>

      {showReview && (
        <ReviewPanel
          reviewTasks={reviewTasks}
          approvedTasks={approvedTasks}
          onSelectTask={(taskId) => {
            void navigate({ to: '/tasks/$taskId', params: { taskId } })
          }}
          onClose={() => setShowReview(false)}
          onMerge={() => {
            void (async () => {
              try {
                await api.merge()
                setShowReview(false)
                await invalidateBoard()
              } catch (err: any) {
                toast.error(err?.message ?? 'Merge failed')
              }
            })()
          }}
          merging={merging}
        />
      )}

      {showCreate && configData && (
        <CreateTaskModal
          config={configData}
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false)
            void invalidateBoard()
          }}
        />
      )}

    </div>
  )
}
