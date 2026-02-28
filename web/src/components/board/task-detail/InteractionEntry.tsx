import * as Collapsible from '@radix-ui/react-collapsible'
import type { ReactNode } from 'react'
import type { Interaction } from '../../../types'
import { useInteractionDetailContext } from './InteractionDetailContext'

interface Props {
  interaction: Interaction
  phase?: string
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

function phaseBadgeTone(phase: string | undefined): string {
  const normalized = phase?.trim().toLowerCase()
  if (normalized === 'plan')
    return 'border-indigo-500/35 bg-indigo-500/15 text-indigo-300'
  if (normalized === 'run')
    return 'border-emerald-500/35 bg-emerald-500/15 text-emerald-300'
  if (normalized === 'review')
    return 'border-amber-500/35 bg-amber-500/15 text-amber-300'
  if (normalized === 'evaluate')
    return 'border-cyan-500/35 bg-cyan-500/15 text-cyan-300'
  if (normalized === 'decompose')
    return 'border-orange-500/35 bg-orange-500/15 text-orange-300'
  if (normalized === 'merge')
    return 'border-purple-500/35 bg-purple-500/15 text-purple-300'
  return 'border-slate-500/35 bg-slate-500/15 text-slate-300'
}

export function InteractionEntry({
  interaction,
  phase,
  collapsible = false,
  expanded = false,
  onExpandedChange,
  alwaysExpanded = false,
  showDiffSummary = false,
  children,
}: Props) {
  const detailContext = useInteractionDetailContext()
  const activeLogId = detailContext?.activeLogId ?? null
  const onToggleLog = detailContext?.onToggleLog
  const isRunning = interaction.status === 'running'
  const phaseLabel = phase?.trim()
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
              {phaseLabel && (
                <span
                  className={[
                    'rounded border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.05em]',
                    phaseBadgeTone(phaseLabel),
                  ].join(' ')}
                >
                  [{phaseLabel.toUpperCase()}]
                </span>
              )}
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

        {onToggleLog && (
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
        )}
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
