import { createFileRoute } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useMutation } from '@tanstack/react-query'
import { api } from '../api'
import { CreateTaskModal } from '../components/board/CreateTaskModal'
import { TasksTable } from '../components/board/TasksTable'
import {
  TasksToolbar,
  type TaskListFilter,
} from '../components/board/TasksToolbar'
import { toast } from 'sonner'
import { useConfigQuery } from '../hooks/queries/useConfig'
import { useModelsQuery } from '../hooks/queries/useModels'
import { useRunningOperations } from '../hooks/queries/useRunningOperations'
import { useTasksQuery } from '../hooks/queries/useTasks'
import type { Task } from '../types'

const STATUS_PRIORITY: Record<Task['status'], number> = {
  running: 0,
  review: 1,
  failed: 2,
  planned: 3,
  pending: 4,
  approved: 5,
  merged: 6,
}

function taskMatchesFilter(task: Task, filter: TaskListFilter) {
  if (filter === 'all') return true
  if (filter === 'pending') return task.status === 'pending'
  if (filter === 'planned') return task.status === 'planned'
  if (filter === 'running') return task.status === 'running'
  if (filter === 'review') return task.status === 'review'
  if (filter === 'approved') return task.status === 'approved'
  if (filter === 'merged') return task.status === 'merged'
  if (filter === 'failed') return task.status === 'failed'
  return true
}

export function TasksPage() {
  const navigate = useNavigate()
  const tasksQuery = useTasksQuery()
  const configQuery = useConfigQuery()
  const allModelsQuery = useModelsQuery()
  const { isRunning } = useRunningOperations()
  const runTasksMutation = useMutation({
    mutationFn: (taskIds?: string[]) => api.runTasks(taskIds),
  })

  const [showCreate, setShowCreate] = useState(false)
  const [activeFilter, setActiveFilter] = useState<TaskListFilter>('all')
  const [search, setSearch] = useState('')

  const tasks = tasksQuery.data?.tasks ?? []
  const loading = tasksQuery.isLoading || configQuery.isLoading
  const configData = configQuery.data

  void allModelsQuery.data

  const approvedTasks = useMemo(
    () => tasks.filter((t) => t.status === 'approved'),
    [tasks],
  )

  const pendingCount = useMemo(
    () => tasks.filter((task) => task.status === 'pending').length,
    [tasks],
  )
  const plannedCount = useMemo(
    () => tasks.filter((task) => task.status === 'planned').length,
    [tasks],
  )
  const runningCount = useMemo(
    () => tasks.filter((task) => task.status === 'running').length,
    [tasks],
  )
  const reviewCount = useMemo(
    () => tasks.filter((task) => task.status === 'review').length,
    [tasks],
  )
  const approvedCount = useMemo(
    () => tasks.filter((task) => task.status === 'approved').length,
    [tasks],
  )
  const mergedCount = useMemo(
    () => tasks.filter((task) => task.status === 'merged').length,
    [tasks],
  )
  const failedCount = useMemo(
    () => tasks.filter((task) => task.status === 'failed').length,
    [tasks],
  )

  const visibleTasks = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase()

    return [...tasks]
      .filter((task) => taskMatchesFilter(task, activeFilter))
      .filter((task) =>
        normalizedSearch
          ? task.title.toLowerCase().includes(normalizedSearch)
          : true,
      )
      .sort((a, b) => {
        const byStatus = STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status]
        if (byStatus !== 0) return byStatus
        return Date.parse(b.updated_at) - Date.parse(a.updated_at)
      })
  }, [tasks, activeFilter, search])

  const runTasks = async (taskIds?: string[]) => {
    try {
      await runTasksMutation.mutateAsync(taskIds)
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
          hasApprovedTasks={approvedTasks.length > 0}
          decomposeRunning={decomposeRunning}
          cleanupRunning={cleanupRunning}
          exploring={exploring}
          activeFilter={activeFilter}
          search={search}
          totalTasks={tasks.length}
          visibleTasks={visibleTasks.length}
          pendingCount={pendingCount}
          plannedCount={plannedCount}
          runningCount={runningCount}
          reviewCount={reviewCount}
          approvedCount={approvedCount}
          mergedCount={mergedCount}
          failedCount={failedCount}
          onRun={() => {
            void runTasks()
          }}
          onMerge={() => {
            void api.merge().catch((err: any) => {
              toast.error(err?.message ?? 'Merge failed')
            })
          }}
          onCreateTask={() => setShowCreate(true)}
          onFilterChange={setActiveFilter}
          onSearchChange={setSearch}
        />

        {tasks.length === 0 ? (
          <div className="flex min-h-0 flex-1 items-center justify-center px-6">
            <div className="flex max-w-sm flex-col items-center gap-3 text-center">
              <p className="text-sm">No tasks yet.</p>
              <button
                type="button"
                onClick={() => setShowCreate(true)}
                className="inline-flex items-center rounded-lg border border-accent bg-accent px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent/90"
              >
                Create your first task →
              </button>
            </div>
          </div>
        ) : (
          <TasksTable tasks={visibleTasks} />
        )}
      </div>

      {showCreate && configData && (
        <CreateTaskModal
          config={configData}
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false)
          }}
        />
      )}
    </div>
  )
}

export const Route = createFileRoute('/')({
  component: TasksPage,
})
