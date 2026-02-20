import { useState } from 'react'
import type { Sprint } from '../../types'
import { api } from '../../api'
import { ActionButton } from '../common/ActionButton'
import { StatusBadge } from '../common/StatusBadge'
import { useReviewQuery } from '../../hooks/queries/useSprints'

interface Props {
  sprint: Sprint
  onClose: () => void
  onIntegrated: () => void
}

export function ReviewPanel({ sprint, onClose, onIntegrated }: Props) {
  const [expandedDiff, setExpandedDiff] = useState<string | null>(null)
  const [integrating, setIntegrating] = useState(false)
  const reviewQuery = useReviewQuery(sprint.id)

  const artifacts = reviewQuery.data?.artifacts ?? []

  const handleIntegrate = async () => {
    setIntegrating(true)
    try {
      await api.integrate(sprint.id)
      onIntegrated()
    } catch (err: any) {
      alert(err.message ?? 'Integration failed')
    } finally {
      setIntegrating(false)
    }
  }

  const completed = artifacts.filter((a) => a.status === 'completed')

  return (
    <div className="flex w-[480px] shrink-0 flex-col overflow-hidden border-l border-border bg-[var(--bg-primary)]">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2.5">
          <h2 className="text-sm font-semibold">
            Review - Sprint {sprint.id.slice(0, 8)}
          </h2>
          <span className="text-xs text-[var(--text-secondary)]">
            {completed.length} completed / {artifacts.length} total
          </span>
        </div>
        <button
          className="rounded px-1.5 py-1 text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]"
          onClick={onClose}
        >
          ✕
        </button>
      </div>

      <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
        {reviewQuery.isLoading && (
          <div className="py-6 text-center text-[13px] text-[var(--text-secondary)]">
            Loading artifacts...
          </div>
        )}
        {!reviewQuery.isLoading && artifacts.length === 0 && (
          <div className="py-6 text-center text-[13px] text-[var(--text-secondary)]">
            No artifacts to review
          </div>
        )}
        {artifacts.map((a) => (
          <div
            key={a.task_id}
            className="overflow-hidden rounded border border-border"
          >
            <div className="flex flex-wrap items-center gap-2 bg-[var(--bg-secondary)] px-3 py-2.5">
              <StatusBadge status={a.status} />
              <span className="min-w-[120px] flex-1 text-[13px] font-medium">
                {a.title}
              </span>
              <span className="font-mono text-[10px] text-[var(--text-secondary)]">
                {a.task_id.slice(0, 8)}
              </span>
              {a.duration_ms > 0 && (
                <span className="text-[11px] text-[var(--text-secondary)]">
                  {(a.duration_ms / 1000).toFixed(0)}s
                </span>
              )}
              {a.files && a.files.length > 0 && (
                <div className="flex w-full flex-wrap gap-1">
                  {a.files.map((f) => (
                    <span
                      key={f}
                      className="rounded border border-border bg-[var(--bg-primary)] px-1.5 py-px font-mono text-[10px] text-[var(--text-secondary)]"
                    >
                      {f.split('/').pop()}
                    </span>
                  ))}
                </div>
              )}
              {a.diff && (
                <button
                  className="ml-auto whitespace-nowrap rounded border border-border px-2 py-0.5 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-primary)]"
                  onClick={() =>
                    setExpandedDiff(
                      expandedDiff === a.task_id ? null : a.task_id,
                    )
                  }
                >
                  {expandedDiff === a.task_id ? 'Hide diff' : 'Show diff'}
                </button>
              )}
            </div>
            {expandedDiff === a.task_id && a.diff && (
              <pre className="max-h-[400px] overflow-auto border-t border-border bg-[var(--bg-primary)] p-3 font-mono text-[11px] leading-[1.5]">
                {a.diff}
              </pre>
            )}
          </div>
        ))}
      </div>

      {completed.length > 0 && (
        <div className="flex shrink-0 items-center justify-between border-t border-border px-4 py-3">
          <span className="text-xs text-[var(--text-secondary)]">
            {completed.length} task{completed.length !== 1 ? 's' : ''} ready to
            integrate
          </span>
          <ActionButton
            variant="primary"
            onClick={handleIntegrate}
            disabled={integrating}
          >
            {integrating ? 'Integrating...' : 'Integrate All'}
          </ActionButton>
        </div>
      )}
    </div>
  )
}
