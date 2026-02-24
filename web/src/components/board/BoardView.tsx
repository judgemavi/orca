import type { WSEvent } from '../../types'
import { api } from '../../api'
import { CreateTaskModal } from './CreateTaskModal'
import { TaskDetailModal } from './task-detail/TaskDetailModal'
import { ReviewPanel } from './ReviewPanel'
import { Toast } from '../common/Toast'
import { BoardHeader } from './BoardHeader'
import { BoardColumns } from './BoardColumns'
import { useBoardState } from './useBoardState'

interface Props {
  lastWSEvent: WSEvent | null
}

export function BoardView({ lastWSEvent }: Props) {
  const {
    actionLoading,
    showCreate,
    setShowCreate,
    setSelectedTaskId,
    showReview,
    setShowReview,
    toastError,
    setToastError,
    sprint,
    configData,
    loading,
    tasksByStatus,
    activeTask,
    selectedTask,
    tools,
    isRunning,
    sensors,
    canDropTaskToColumn,
    invalidateBoard,
    refreshAfterTaskUpdate,
    runSprintAction,
    handleDragStart,
    handleDragEnd,
  } = useBoardState()

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
  const merging = isRunning('merge')
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
          merging={merging}
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
          onMerge={() => {
            void runSprintAction(() => api.merge())
          }}
          onResetSprint={(sprintId) => {
            void runSprintAction(() => api.resetSprint(sprintId))
          }}
        />

        <BoardColumns
          tasksByStatus={tasksByStatus}
          activeTask={activeTask}
          canDropTaskToColumn={canDropTaskToColumn}
          sensors={sensors}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onCreateTask={() => setShowCreate(true)}
          onSelectTask={(taskId) => setSelectedTaskId(taskId)}
          refreshAfterTaskUpdate={refreshAfterTaskUpdate}
        />
      </div>

      {showReview &&
        sprint &&
        (sprint.status === 'completed' || sprint.status === 'failed') && (
          <ReviewPanel
            sprint={sprint}
            onClose={() => setShowReview(false)}
            onMerged={() => {
              setShowReview(false)
              void invalidateBoard()
            }}
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
