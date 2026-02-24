import { useEffect, useMemo, useRef } from 'react'
import { X } from 'lucide-react'
import {
  useInteractionContent,
  useInteractionsQuery,
  useInteractionStream,
} from './useInteractions'

interface Props {
  taskId: string
  interactionId: string
  onClose: () => void
}

const PHASE_LABELS: Record<string, string> = {
  plan: 'Planning',
  run: 'Execution',
  merge: 'Merge',
}

function formatTokenCount(value: number | undefined): string {
  if (!Number.isFinite(value)) return '0'
  if (value && value >= 1000) return `${(value / 1000).toFixed(1)}k`
  return `${value ?? 0}`
}

function formatCost(value: number | undefined): string {
  if (!Number.isFinite(value)) return '$0.00'
  return `$${(value ?? 0).toFixed(2)}`
}

function formatDuration(durationMs: number | undefined): string {
  if (!Number.isFinite(durationMs) || !durationMs || durationMs < 0) return '-'
  if (durationMs < 1000) return `${durationMs} ms`
  const totalSeconds = Math.floor(durationMs / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 1) return `${seconds}s`
  return `${minutes}m ${seconds}s`
}

export function InteractionLogPanel({ taskId, interactionId, onClose }: Props) {
  const interactionsQuery = useInteractionsQuery(taskId)

  const selectedInteraction = useMemo(
    () =>
      (interactionsQuery.data ?? []).find((item) => item.id === interactionId) ??
      null,
    [interactionId, interactionsQuery.data],
  )

  const contentQuery = useInteractionContent(taskId, interactionId)

  const stream = useInteractionStream(
    taskId,
    interactionId,
    Boolean(selectedInteraction && selectedInteraction.status === 'running'),
  )

  const content =
    selectedInteraction?.status === 'running'
      ? stream.content || contentQuery.data?.content || ''
      : contentQuery.data?.content || ''

  const logBodyRef = useRef<HTMLPreElement | null>(null)

  useEffect(() => {
    const el = logBodyRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [content])

  const titlePrefix = PHASE_LABELS[selectedInteraction?.phase ?? ''] ?? 'Interaction'
  const title = selectedInteraction
    ? `${titlePrefix} #${selectedInteraction.attempt} Log`
    : 'Interaction Log'

  return (
    <section className="flex h-full min-h-0 flex-col rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-primary)]">
      <header className="flex items-center justify-between border-b border-[var(--border)] px-3 py-2.5">
        <div className="text-sm font-medium text-[var(--text-primary)]">{title}</div>
        <button
          type="button"
          className="rounded border border-[var(--border)] p-1 text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
          onClick={onClose}
          aria-label="Close log panel"
        >
          <X size={14} />
        </button>
      </header>

      <div className="min-h-0 flex-1 p-3">
        <pre
          ref={logBodyRef}
          className="h-full min-h-[220px] overflow-auto rounded-md border border-slate-700 bg-slate-950 p-3 font-mono text-[11px] leading-relaxed text-slate-100"
        >
          {!selectedInteraction
            ? 'Interaction not found.'
            : content ||
              (selectedInteraction.status === 'running'
                ? 'Waiting for streaming output...'
                : 'No content.')}
        </pre>

        {selectedInteraction?.status === 'failed' &&
          (selectedInteraction.error || contentQuery.data?.error) && (
          <div className="mt-2 text-xs text-[var(--status-failed)]">
            Error: {selectedInteraction.error || contentQuery.data?.error}
          </div>
        )}
      </div>

      <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-[var(--border)] px-3 py-2 text-xs text-[var(--text-secondary)]">
        <span>
          Tokens: {formatTokenCount(selectedInteraction?.input_tokens)} in /{' '}
          {formatTokenCount(selectedInteraction?.output_tokens)} out
        </span>
        <span>Cost: {formatCost(selectedInteraction?.estimated_cost)}</span>
        <span>
          Duration:{' '}
          {formatDuration(contentQuery.data?.duration_ms ?? selectedInteraction?.duration_ms)}
        </span>
        {stream.isStreaming && <span className="text-emerald-500">Streaming</span>}
      </footer>
    </section>
  )
}
