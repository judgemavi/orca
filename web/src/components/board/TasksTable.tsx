import { useMemo, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import type { Task } from '../../types'

type SortKey = 'status' | 'title' | 'created' | 'updated'
type SortDirection = 'asc' | 'desc'

interface Props {
  tasks: Task[]
}

const STATUS_PRIORITY: Record<Task['status'], number> = {
  running: 0,
  review: 1,
  failed: 2,
  planned: 3,
  pending: 4,
  approved: 5,
  merged: 6,
}

const STATUS_STYLES: Record<Task['status'], string> = {
  pending: 'bg-slate-500/15 text-slate-300',
  planned: 'bg-indigo-500/15 text-indigo-300',
  running: 'bg-blue-500/15 text-blue-300',
  review: 'bg-amber-500/15 text-amber-300',
  failed: 'bg-red-500/15 text-red-300',
  approved: 'bg-green-500/15 text-green-300',
  merged: 'bg-violet-500/15 text-violet-300',
}

function formatRelativeTime(iso: string) {
  const timestamp = Date.parse(iso)
  if (!Number.isFinite(timestamp)) return 'just now'
  const deltaSeconds = Math.round((timestamp - Date.now()) / 1000)
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

  const intervals = [
    { unit: 'year', seconds: 60 * 60 * 24 * 365 },
    { unit: 'month', seconds: 60 * 60 * 24 * 30 },
    { unit: 'week', seconds: 60 * 60 * 24 * 7 },
    { unit: 'day', seconds: 60 * 60 * 24 },
    { unit: 'hour', seconds: 60 * 60 },
    { unit: 'minute', seconds: 60 },
  ] as const

  for (const interval of intervals) {
    if (Math.abs(deltaSeconds) >= interval.seconds) {
      return rtf.format(
        Math.round(deltaSeconds / interval.seconds),
        interval.unit,
      )
    }
  }

  return rtf.format(deltaSeconds, 'second')
}

function SortableHeader({
  label,
  active,
  direction,
  onClick,
}: {
  label: string
  active: boolean
  direction: SortDirection
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 text-left text-xs font-semibold uppercase tracking-wide "
    >
      {label}
      <span className="text-[10px]">
        {active ? (direction === 'asc' ? '▲' : '▼') : '↕'}
      </span>
    </button>
  )
}

export function TasksTable({ tasks }: Props) {
  const navigate = useNavigate()
  const [filter, setFilter] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('status')
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc')

  const filteredAndSortedTasks = useMemo(() => {
    const normalizedFilter = filter.trim().toLowerCase()
    const filtered = normalizedFilter
      ? tasks.filter((task) =>
          task.title.toLowerCase().includes(normalizedFilter),
        )
      : tasks

    return [...filtered].sort((a, b) => {
      let result = 0

      if (sortKey === 'status') {
        result = STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status]
        if (result === 0) {
          result = Date.parse(b.updated_at) - Date.parse(a.updated_at)
        }
      }

      if (sortKey === 'title') {
        result = a.title.localeCompare(b.title)
      }

      if (sortKey === 'created') {
        result = Date.parse(a.created_at) - Date.parse(b.created_at)
      }

      if (sortKey === 'updated') {
        result = Date.parse(a.updated_at) - Date.parse(b.updated_at)
      }

      if (result === 0) {
        result = a.id.localeCompare(b.id)
      }

      return sortDirection === 'asc' ? result : -result
    })
  }, [tasks, filter, sortKey, sortDirection])

  const onSortChange = (key: SortKey) => {
    if (sortKey === key) {
      setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'))
      return
    }

    setSortKey(key)
    setSortDirection('asc')
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="border-b border-slate-700 px-4 py-2.5">
        <input
          type="text"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter by title"
          className="w-full rounded-md border border-slate-700 px-3 py-1.5 text-sm outline-none focus:border-blue-500"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
        <table className="min-w-full border-collapse text-[13px]">
          <thead className="sticky top-0 z-10">
            <tr className="border-b border-slate-700">
              <th className="px-3 py-2 text-left">
                <SortableHeader
                  label="Status"
                  active={sortKey === 'status'}
                  direction={sortDirection}
                  onClick={() => onSortChange('status')}
                />
              </th>
              <th className="px-3 py-2 text-left">
                <SortableHeader
                  label="Title"
                  active={sortKey === 'title'}
                  direction={sortDirection}
                  onClick={() => onSortChange('title')}
                />
              </th>
              <th className="px-3 py-2 text-left">
                <SortableHeader
                  label="Created"
                  active={sortKey === 'created'}
                  direction={sortDirection}
                  onClick={() => onSortChange('created')}
                />
              </th>
              <th className="px-3 py-2 text-left">
                <SortableHeader
                  label="Updated"
                  active={sortKey === 'updated'}
                  direction={sortDirection}
                  onClick={() => onSortChange('updated')}
                />
              </th>
            </tr>
          </thead>
          <tbody>
            {filteredAndSortedTasks.map((task) => (
              <tr
                key={task.id}
                className="cursor-pointer border-b border-slate-700/70 transition "
                onClick={() => {
                  void navigate({
                    to: '/$taskId',
                    params: { taskId: task.id },
                  })
                }}
              >
                <td className="px-3 py-2">
                  <span
                    className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium capitalize ${STATUS_STYLES[task.status]}`}
                  >
                    {task.status}
                  </span>
                </td>
                <td className="max-w-[36rem] truncate px-3 py-2">
                  {task.title}
                </td>
                <td className="whitespace-nowrap px-3 py-2">
                  {formatRelativeTime(task.created_at)}
                </td>
                <td className="whitespace-nowrap px-3 py-2">
                  {formatRelativeTime(task.updated_at)}
                </td>
              </tr>
            ))}
            {filteredAndSortedTasks.length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-8 text-center text-sm">
                  No tasks match the current filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
