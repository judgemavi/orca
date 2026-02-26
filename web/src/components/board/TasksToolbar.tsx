import { ActionButton } from '../common/ActionButton'

export type TaskListFilter =
  | 'all'
  | 'pending'
  | 'planned'
  | 'running'
  | 'review'
  | 'approved'
  | 'merged'
  | 'failed'

interface Props {
  actionLoading: boolean
  startPending: boolean
  mergePending: boolean
  hasApprovedTasks: boolean
  activeFilter: TaskListFilter
  search: string
  totalTasks: number
  pendingCount: number
  plannedCount: number
  runningCount: number
  reviewCount: number
  approvedCount: number
  mergedCount: number
  failedCount: number
  onStart: () => void
  onMerge: () => void
  onCreateTask: () => void
  onFilterChange: (filter: TaskListFilter) => void
  onSearchChange: (value: string) => void
}

export function TasksToolbar({
  actionLoading,
  startPending,
  mergePending,
  hasApprovedTasks,
  activeFilter,
  search,
  totalTasks,
  pendingCount,
  plannedCount,
  runningCount,
  reviewCount,
  approvedCount,
  mergedCount,
  failedCount,
  onStart,
  onMerge,
  onCreateTask,
  onFilterChange,
  onSearchChange,
}: Props) {
  const filterTabs: Array<{
    key: TaskListFilter
    label: string
    count: number
  }> = [
      { key: 'all', label: 'All', count: totalTasks },
      { key: 'pending', label: 'Pending', count: pendingCount },
      { key: 'planned', label: 'Planned', count: plannedCount },
      { key: 'running', label: 'Running', count: runningCount },
      { key: 'review', label: 'Review', count: reviewCount },
      { key: 'approved', label: 'Approved', count: approvedCount },
      { key: 'merged', label: 'Merged', count: mergedCount },
      { key: 'failed', label: 'Failed', count: failedCount },
    ]

  return (
    <div className="flex shrink-0 flex-col gap-2 border-b border-border px-4 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          {filterTabs
            .filter((tab) => tab.key === 'all' || tab.count > 0)
            .map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => onFilterChange(tab.key)}
                className={`rounded-full px-2.5 py-1 text-xs transition-colors ${activeFilter === tab.key
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
          className="w-full max-w-60 rounded-md border border-border-subtle px-2.5 py-1 text-xs outline-none focus:border-accent"
        />
        <div className="flex items-center gap-2">
          <ActionButton
            variant="primary"
            size="toolbar"
            onClick={onStart}
            disabled={actionLoading || startPending}
          >
            {startPending ? 'Starting...' : 'Start All'}
          </ActionButton>
          <ActionButton variant="primary" size="toolbar" onClick={onCreateTask}>
            Create Task
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
    </div>
  )
}
