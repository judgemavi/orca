import { ActionButton } from '../common/ActionButton'

export type TaskListFilter = 'all' | 'pending' | 'running' | 'review' | 'done'

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
  activeFilter: TaskListFilter
  search: string
  totalTasks: number
  visibleTasks: number
  pendingCount: number
  runningCount: number
  reviewCount: number
  doneCount: number
  onRun: () => void
  onToggleReview: () => void
  onMerge: () => void
  onCreateTask: () => void
  onFilterChange: (filter: TaskListFilter) => void
  onSearchChange: (value: string) => void
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
  activeFilter,
  search,
  totalTasks,
  visibleTasks,
  pendingCount,
  runningCount,
  reviewCount,
  doneCount,
  onRun,
  onToggleReview,
  onMerge,
  onCreateTask,
  onFilterChange,
  onSearchChange,
}: Props) {
  const doneProgress = totalTasks > 0 ? Math.round((doneCount / totalTasks) * 100) : 0

  const filterTabs: Array<{ key: TaskListFilter; label: string; count: number }> = [
    { key: 'all', label: 'All', count: totalTasks },
    { key: 'pending', label: 'Pending', count: pendingCount },
    { key: 'running', label: 'Running', count: runningCount },
    { key: 'review', label: 'Review', count: reviewCount },
    { key: 'done', label: 'Done', count: doneCount },
  ]

  return (
    <div className="flex shrink-0 flex-col gap-2 border-b border-border px-4 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-[260px] flex-1 flex-col gap-1">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-xs font-semibold uppercase tracking-wide">
              Tasks
            </span>
            <span className="text-xs text-foreground/70">
              {visibleTasks} of {totalTasks}
            </span>
            {(decomposeRunning || cleanupRunning || exploring) && (
              <span className="text-xs text-accent">
                {decomposeRunning && 'Decomposing... '}
                {cleanupRunning && 'Cleaning... '}
                {exploring && 'Exploring...'}
              </span>
            )}
          </div>
          <div className="h-1.5 w-full max-w-[280px] overflow-hidden rounded bg-surface-alt">
            <div
              className="h-full rounded bg-accent transition-all"
              style={{ width: `${doneProgress}%` }}
            />
          </div>
        </div>

        <div className="flex items-center gap-2">
          <ActionButton
            variant="primary"
            size="toolbar"
            onClick={onRun}
            disabled={actionLoading || runPending}
          >
            {runPending ? 'Running...' : 'Run All'}
          </ActionButton>
          <ActionButton variant="primary" size="toolbar" onClick={onCreateTask}>
            Create Task
          </ActionButton>
          <ActionButton
            variant="default"
            size="toolbar"
            onClick={onToggleReview}
            disabled={!hasReviewTasks}
          >
            {reviewOpen ? 'Hide Review' : 'Review'}
          </ActionButton>
          <ActionButton
            variant="default"
            size="toolbar"
            onClick={onMerge}
            disabled={actionLoading || mergePending || !hasApprovedTasks}
          >
            {mergePending ? 'Merging...' : 'Merge'}
          </ActionButton>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          {filterTabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => onFilterChange(tab.key)}
              className={`rounded-full px-2.5 py-1 text-xs transition-colors ${
                activeFilter === tab.key
                  ? 'bg-accent text-white'
                  : 'bg-surface-alt text-foreground/70 hover:text-foreground'
              }`}
            >
              {tab.label} {tab.count}
            </button>
          ))}
        </div>

        <input
          type="text"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search tasks"
          className="w-full max-w-[240px] rounded-md border border-border-subtle px-2.5 py-1 text-xs outline-none focus:border-accent"
        />
      </div>
    </div>
  )
}
