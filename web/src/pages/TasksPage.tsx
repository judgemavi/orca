import { useNavigate } from '@tanstack/react-router'
import { api } from '../api'
import { ReviewPanel } from '../components/board/ReviewPanel'
import { CreateTaskModal } from '../components/board/CreateTaskModal'
import { TasksTable } from '../components/board/TasksTable'
import { TasksToolbar } from '../components/board/TasksToolbar'
import { useTasksState } from '../components/board/useTasksState'
import { Toast } from '../components/common/Toast'

export function TasksPage() {
  const navigate = useNavigate()
  const {
    actionLoading,
    showCreate,
    setShowCreate,
    showReview,
    setShowReview,
    toastError,
    setToastError,
    tasks,
    configData,
    loading,
    reviewTasks,
    approvedTasks,
    isRunning,
    invalidateBoard,
    runTasks,
  } = useTasksState()

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
          actionLoading={actionLoading}
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
                setToastError(err?.message ?? 'Merge failed')
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
                setToastError(err?.message ?? 'Merge failed')
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

      <Toast
        message={toastError}
        type="error"
        onClose={() => setToastError(null)}
      />
    </div>
  )
}
