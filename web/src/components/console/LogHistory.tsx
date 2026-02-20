import { useMemo, useState } from 'react'
import type { LogEntry } from '../../types'
import { useLogsQuery } from '../../hooks/queries/useLogs'
import { StatusBadge } from '../common/StatusBadge'

interface Props {
  onOpenLog: (entry: LogEntry) => void
}

function formatSize(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatRelativeTime(input: string): string {
  const date = new Date(input)
  const deltaMs = Date.now() - date.getTime()
  if (!Number.isFinite(deltaMs)) return 'unknown time'

  const mins = Math.floor(deltaMs / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function titleFor(entry: LogEntry): string {
  return entry.task_title?.trim() || `Task ${entry.task_id.slice(0, 8)}`
}

export function LogHistory({ onOpenLog }: Props) {
  const { data: logs = [], isLoading, isError } = useLogsQuery()
  const [search, setSearch] = useState('')

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return logs
    return logs.filter((entry) => {
      const haystack = `${titleFor(entry)} ${entry.task_id}`.toLowerCase()
      return haystack.includes(query)
    })
  }, [logs, search])

  return (
    <div className="h-full overflow-auto bg-[#0f1320] p-3">
      <div className="mb-3 flex items-center justify-between gap-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by task title or ID"
          className="w-full rounded border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-sm text-slate-100 placeholder:text-slate-500"
        />
      </div>

      {isLoading && <div className="text-sm text-slate-400">Loading logs...</div>}
      {isError && (
        <div className="text-sm text-rose-300">Failed to load historical logs.</div>
      )}
      {!isLoading && !isError && filtered.length === 0 && (
        <div className="text-sm italic text-slate-500">No logs yet.</div>
      )}

      <div className="space-y-2">
        {filtered.map((entry) => (
          <button
            key={`${entry.task_id}-${entry.modified_at}`}
            type="button"
            className="w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-left transition hover:border-slate-500"
            onClick={() => onOpenLog(entry)}
          >
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="truncate text-sm text-slate-100">{titleFor(entry)}</span>
              {entry.task_status ? <StatusBadge status={entry.task_status} /> : null}
            </div>
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span className="font-mono">{entry.task_id.slice(0, 8)}</span>
              <span>
                {entry.size_bytes === 0
                  ? 'Empty log'
                  : `${formatSize(entry.size_bytes)} • ${formatRelativeTime(entry.modified_at)}`}
              </span>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
