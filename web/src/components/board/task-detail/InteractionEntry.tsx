import type { ReactNode } from 'react'
import type { Interaction } from '../../../types'

interface Props {
  interaction: Interaction
  activeLogId: string | null
  onToggleLog: (id: string) => void
  children?: ReactNode
}

function formatDuration(durationMs: number | undefined): string {
  if (!Number.isFinite(durationMs) || !durationMs || durationMs < 0) return '-'
  if (durationMs < 1000) return `${durationMs} ms`
  return `${(durationMs / 1000).toFixed(1)}s`
}

function formatCost(value: number | undefined): string {
  if (!Number.isFinite(value)) return '$0.00'
  return `$${(value ?? 0).toFixed(2)}`
}

function statusIcon(status: Interaction['status']) {
  if (status === 'completed') return '✓'
  if (status === 'failed') return '✕'
  return '⟳'
}

export function InteractionEntry({
  interaction,
  activeLogId,
  onToggleLog,
  children,
}: Props) {
  const isRunning = interaction.status === 'running'

  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--bg-primary)] p-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2 text-xs">
          <span
            className={[
              'inline-flex h-4 w-4 items-center justify-center rounded-full border text-[11px]',
              interaction.status === 'completed'
                ? 'border-emerald-500 text-emerald-500'
                : interaction.status === 'failed'
                  ? 'border-[var(--status-failed)] text-[var(--status-failed)]'
                  : 'animate-pulse border-[var(--accent)] text-[var(--accent)]',
            ].join(' ')}
            aria-hidden
          >
            {statusIcon(interaction.status)}
          </span>
          <span className="font-mono text-[var(--text-primary)]">#{interaction.attempt}</span>
          <span className="truncate text-[var(--text-secondary)]">{interaction.tool || '-'}</span>
          <span className="font-mono text-[var(--text-secondary)]">
            {formatDuration(interaction.duration_ms)}
          </span>
          <span className="font-mono text-[var(--text-secondary)]">
            {formatCost(interaction.estimated_cost)}
          </span>
          {isRunning && (
            <span className="rounded border border-[var(--accent)]/40 bg-[var(--accent)]/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.04em] text-[var(--accent)]">
              running
            </span>
          )}
        </div>

        <button
          type="button"
          className={[
            'rounded border px-2 py-0.5 text-[11px] transition-colors',
            activeLogId === interaction.id
              ? 'border-[var(--accent)] bg-[var(--accent)]/15 text-[var(--accent)]'
              : 'border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
          ].join(' ')}
          onClick={() => onToggleLog(interaction.id)}
        >
          {activeLogId === interaction.id ? 'log open' : 'log'}
        </button>
      </div>

      {children && (
        <div className={['mt-2.5 flex flex-col gap-2', isRunning ? 'opacity-95' : ''].join(' ')}>
          {children}
        </div>
      )}
    </div>
  )
}
