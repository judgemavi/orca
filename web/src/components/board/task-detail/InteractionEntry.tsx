import * as Collapsible from '@radix-ui/react-collapsible'
import type { ReactNode } from 'react'
import type { Interaction } from '../../../types'

interface Props {
  interaction: Interaction
  activeLogId: string | null
  onToggleLog: (id: string) => void
  collapsible?: boolean
  expanded?: boolean
  onExpandedChange?: (expanded: boolean) => void
  alwaysExpanded?: boolean
  showDiffSummary?: boolean
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
  if (status === 'failed') return '✗'
  return '●'
}

function summarizeDiff(diff: string | undefined): string | null {
  if (!diff) return null
  let added = 0
  let removed = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) {
      added++
      continue
    }
    if (line.startsWith('-')) {
      removed++
    }
  }
  if (added === 0 && removed === 0) return null
  return `+${added}/-${removed}`
}

export function InteractionEntry({
  interaction,
  activeLogId,
  onToggleLog,
  collapsible = false,
  expanded = false,
  onExpandedChange,
  alwaysExpanded = false,
  showDiffSummary = false,
  children,
}: Props) {
  const isRunning = interaction.status === 'running'
  const open = collapsible ? alwaysExpanded || expanded : true
  const diffSummary = showDiffSummary ? summarizeDiff(interaction.diff) : null
  const rowClass = [
    'flex w-full items-center justify-between gap-2 rounded-md px-1 py-0.5 text-left transition-colors',
    alwaysExpanded ? '' : 'cursor-pointer hover:bg-surface/50',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <Collapsible.Root
      className="rounded-lg bg-surface-alt p-4"
      open={open}
      onOpenChange={onExpandedChange}
    >
      <div className="flex items-center justify-between gap-2">
        <Collapsible.Trigger asChild disabled={!collapsible || alwaysExpanded}>
          <button type="button" className={rowClass}>
            <div className="flex min-w-0 items-center gap-2 text-xs">
              {collapsible && !alwaysExpanded && (
                <span className="font-mono text-[11px]" aria-hidden>
                  {open ? '▾' : '▸'}
                </span>
              )}
              <span
                className={[
                  'inline-flex h-4 w-4 items-center justify-center rounded-full border text-xs',
                  interaction.status === 'completed'
                    ? 'border-emerald-500 text-emerald-500'
                    : interaction.status === 'failed'
                      ? 'border-danger text-danger'
                      : 'animate-pulse border-accent text-accent',
                ].join(' ')}
                aria-hidden
              >
                {statusIcon(interaction.status)}
              </span>
              <span className="font-mono">#{interaction.attempt}</span>
              <span className="truncate">{interaction.tool || '-'}</span>
              <span className="font-mono">
                {isRunning ? '-' : formatDuration(interaction.duration_ms)}
              </span>
              <span className="font-mono">
                {formatCost(interaction.estimated_cost)}
              </span>
              {diffSummary && (
                <span className="font-mono text-muted">{diffSummary}</span>
              )}
              {isRunning && (
                <span className="rounded border border-accent/40 bg-accent/10 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-accent">
                  running
                </span>
              )}
            </div>
          </button>
        </Collapsible.Trigger>

        <button
          type="button"
          className={[
            'rounded border px-2 py-0.5 text-xs transition-colors hover:bg-surface',
            activeLogId === interaction.id
              ? 'border-accent bg-accent/15 text-accent'
              : 'border-border-subtle',
          ].join(' ')}
          onClick={(event) => {
            event.stopPropagation()
            onToggleLog(interaction.id)
          }}
          aria-label={
            activeLogId === interaction.id
              ? 'Hide interaction log'
              : 'Show interaction log'
          }
        >
          {activeLogId === interaction.id ? 'log open' : 'log'}
        </button>
      </div>

      {children && (
        <Collapsible.Content
          forceMount
          className="grid transition-[grid-template-rows] duration-200 data-[state=closed]:grid-rows-[0fr] data-[state=open]:grid-rows-[1fr]"
        >
          <div className="overflow-hidden">
            <div
              className={[
                'mt-3 flex flex-col gap-2',
                isRunning ? 'opacity-95' : '',
              ].join(' ')}
            >
              {children}
            </div>
          </div>
        </Collapsible.Content>
      )}
    </Collapsible.Root>
  )
}
