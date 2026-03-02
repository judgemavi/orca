import { useEffect, useMemo, useState } from 'react'
import type { Operation } from '../../types'
import { useOperationsQuery } from '../../hooks/queries'

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
  const { data: operations } = useOperationsQuery()
  const [nowMs, setNowMs] = useState(() => Date.now())
  const running = useMemo(
    () => operations?.filter((op) => op.status === 'running'),
    [operations],
  )

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])

  return (
    <details className="relative">
      <summary className="inline-flex list-none select-none items-center gap-2 rounded-full border px-2.5 py-1 text-xs">
        <span className="h-2 w-2 rounded-full bg-accent" />
        {running?.length} active operation{running?.length !== 1 ? 's' : ''}
      </summary>
      <div className="absolute right-0 top-[calc(100%+8px)] z-30 max-h-[260px] min-w-[260px] max-w-[min(360px,calc(100vw-32px))] overflow-auto rounded-lg border border-border-subtle bg-surface-elevated shadow-[0_8px_32px_rgba(0,0,0,0.3)]">
        {running?.map((op) => (
          <div
            key={op.id}
            className="flex justify-between gap-2.5 border-b px-2.5 py-2 last:border-b-0"
          >
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-xs font-semibold">{op.type}</span>
              <span className="font-mono text-[11px]">{formatTarget(op)}</span>
            </div>
            <span className="whitespace-nowrap font-mono text-[11px]">
              {formatElapsed(op.created_at, nowMs)}
            </span>
          </div>
        ))}
      </div>
    </details>
  )
}
