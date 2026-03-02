import type { Task } from '../../types'
import { useTaskListStats } from './useTaskListStats'
import { Button } from '../Button'
import { CreateTaskModal } from './CreateTaskModal'

interface Props {
  tasks: Task[]
  search: string
  loading: {
    action: boolean
    start: boolean
    merge: boolean
  }
  actions: {
    onStart: () => void
    onMerge: () => void
  }
  onSearchChange: (value: string) => void
}

function ToolbarSearch({
  search,
  onSearchChange,
}: {
  search: string
  onSearchChange: (value: string) => void
}) {
  return (
    <input
      type="text"
      value={search}
      onChange={(event) => onSearchChange(event.target.value)}
      placeholder="Search tasks"
      className="w-full max-w-60 rounded-md border border-border-subtle px-2.5 py-1 text-xs outline-none focus:border-accent"
    />
  )
}

function ToolbarActions({
  loading,
  hasApprovedTasks,
  actions,
}: {
  loading: Props['loading']
  hasApprovedTasks: boolean
  actions: Props['actions']
}) {
  return (
    <div className="flex items-center gap-2">
      <Button
        variant="primary"
        onClick={actions.onStart}
        disabled={loading.action || loading.start}
      >
        {loading.start ? 'Starting...' : 'Start All'}
      </Button>
      <CreateTaskModal />
      <Button
        variant="default"
        onClick={actions.onMerge}
        disabled={loading.action || loading.merge || !hasApprovedTasks}
      >
        {loading.merge ? 'Merging...' : 'Merge'}
      </Button>
    </div>
  )
}

export function TasksToolbar({
  tasks,
  search,
  loading,
  actions,
  onSearchChange,
}: Props) {
  const stats = useTaskListStats(tasks)

  return (
    <div className="flex shrink-0 flex-col gap-2 border-b border-border px-4 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <ToolbarSearch search={search} onSearchChange={onSearchChange} />
        <ToolbarActions
          loading={loading}
          hasApprovedTasks={stats.hasApprovedTasks}
          actions={actions}
        />
      </div>
    </div>
  )
}
