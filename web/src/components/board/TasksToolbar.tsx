import { ActionButton } from '../common/ActionButton'

interface Props {
  actionLoading: boolean
  runPending: boolean
  mergePending: boolean
  reviewOpen: boolean
  hasReviewTasks: boolean
  hasApprovedTasks: boolean
  decomposeRunning: boolean
  cleanupRunning: boolean
  exploring: boolean
  onRun: () => void
  onToggleReview: () => void
  onMerge: () => void
  onCreateTask: () => void
}

export function TasksToolbar({
  actionLoading,
  runPending,
  mergePending,
  reviewOpen,
  hasReviewTasks,
  hasApprovedTasks,
  decomposeRunning,
  cleanupRunning,
  exploring,
  onRun,
  onToggleReview,
  onMerge,
  onCreateTask,
}: Props) {
  return (
    <div className="flex shrink-0 items-center justify-between border-b border-border bg-[var(--bg-secondary)] px-4 py-2.5">
      <div className="flex items-center gap-2 text-sm">
        <span className="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
          Tasks
        </span>
        {(decomposeRunning || cleanupRunning || exploring) && (
          <span className="text-xs text-accent">
            {decomposeRunning && 'Decomposing... '}
            {cleanupRunning && 'Cleaning... '}
            {exploring && 'Exploring...'}
          </span>
        )}
      </div>

      <div className="flex items-center gap-2">
        <ActionButton variant="primary" onClick={onRun} disabled={actionLoading || runPending}>
          {runPending ? 'Running...' : 'Run'}
        </ActionButton>

        <ActionButton variant="default" onClick={onToggleReview} disabled={!hasReviewTasks}>
          {reviewOpen ? 'Hide Review' : 'Review'}
        </ActionButton>

        <ActionButton
          variant="primary"
          onClick={onMerge}
          disabled={actionLoading || mergePending || !hasApprovedTasks}
        >
          {mergePending ? 'Merging...' : 'Merge'}
        </ActionButton>

        <ActionButton variant="default" onClick={onCreateTask}>
          + New Task
        </ActionButton>
      </div>
    </div>
  )
}
