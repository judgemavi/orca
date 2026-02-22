import { useEffect, useMemo, useState } from 'react'
import type { Operation } from '../../types'
import { useOperationsQuery } from '../../hooks/queries/useOperations'

function formatElapsed(iso: string, nowMs: number): string {
  const startedMs = Date.parse(iso)
  if (!Number.isFinite(startedMs)) return '0s'
  const elapsedSec = Math.max(0, Math.floor((nowMs - startedMs) / 1000))
  if (elapsedSec < 60) return `${elapsedSec}s`
  const mins = Math.floor(elapsedSec / 60)
  const sec = elapsedSec % 60
  return `${mins}m ${sec}s`
}

function formatTarget(op: Operation): string {
  if (!op.target_id) return 'global'
  return op.target_id.length > 12
    ? `${op.target_id.slice(0, 12)}...`
    : op.target_id
}

export function OperationsIndicator() {
  const operationsQuery = useOperationsQuery()
  const [nowMs, setNowMs] = useState(() => Date.now())
  const operations = useMemo(
    () =>
      (operationsQuery.data?.operations ?? []).filter(
        (op) => op.status === 'running',
      ),
    [operationsQuery.data?.operations],
  )

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])

  if (operations.length === 0) {
    return null
  }

  return (
    <details className="relative">
      <summary className="inline-flex list-none select-none items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--bg-primary)] px-2.5 py-1 text-xs text-[var(--text-secondary)]">
        <span className="h-2 w-2 rounded-full bg-[var(--accent)]" />
        {operations.length} active operation{operations.length !== 1 ? 's' : ''}
      </summary>
      <div className="absolute right-0 top-[calc(100%+8px)] z-30 max-h-[260px] min-w-[260px] max-w-[min(360px,calc(100vw-32px))] overflow-auto rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] shadow-[0_10px_24px_rgba(0,0,0,0.18)]">
        {operations.map((op) => (
          <div
            key={op.id}
            className="flex justify-between gap-2.5 border-b border-[var(--border)] px-2.5 py-2 last:border-b-0"
          >
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-xs font-semibold text-[var(--text-primary)]">
                {op.type}
              </span>
              <span className="font-mono text-[11px] text-[var(--text-secondary)]">
                {formatTarget(op)}
              </span>
            </div>
            <span className="whitespace-nowrap font-mono text-[11px] text-[var(--text-secondary)]">
              {formatElapsed(op.created_at, nowMs)}
            </span>
          </div>
        ))}
      </div>
    </details>
  )
}
