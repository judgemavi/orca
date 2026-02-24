import type { WSEvent } from '../../types'
import { api } from '../../api'
import { CreateTaskModal } from './CreateTaskModal'
import { TaskDetailModal } from './task-detail/TaskDetailModal'
import { ReviewPanel } from './ReviewPanel'
import { Toast } from '../common/Toast'
import { TasksToolbar } from './TasksToolbar'
import { TasksTable } from './TasksTable'
import { useTasksState } from './useTasksState'

interface Props {
  lastWSEvent: WSEvent | null
}

export function TasksView({ lastWSEvent }: Props) {
  const {
    actionLoading,
    showCreate,
    setShowCreate,
    setSelectedTaskId,
    showReview,
    setShowReview,
    toastError,
    setToastError,
    tasks,
    configData,
    loading,
    reviewTasks,
    approvedTasks,
    selectedTask,
    tools,
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
            const selectedReadyTaskId =
              selectedTask &&
              (selectedTask.status === 'pending' ||
                selectedTask.status === 'failed')
                ? selectedTask.id
                : undefined
            void runTasks(
              selectedReadyTaskId ? [selectedReadyTaskId] : undefined,
            )
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

        <TasksTable
          tasks={tasks}
          onSelectTask={(taskId) => setSelectedTaskId(taskId)}
        />
      </div>

      {showReview && (
        <ReviewPanel
          reviewTasks={reviewTasks}
          approvedTasks={approvedTasks}
          onSelectTask={(taskId) => setSelectedTaskId(taskId)}
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

      {selectedTask && configData && (
        <TaskDetailModal
          task={selectedTask}
          tools={tools}
          config={configData}
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
