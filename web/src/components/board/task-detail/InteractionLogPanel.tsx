import { useEffect, useMemo, useRef } from 'react'
import { Dialog, DialogContent } from '@tiny-bits/react-dialog'

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
  evaluate: 'Evaluation',
  decompose: 'Breakdown',
  run: 'Execution',
  review: 'Review',
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
      (interactionsQuery.data ?? []).find(
        (item) => item.id === interactionId,
      ) ?? null,
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

  const titlePrefix =
    PHASE_LABELS[selectedInteraction?.phase ?? ''] ?? 'Interaction'
  const title = selectedInteraction
    ? `${titlePrefix} #${selectedInteraction.attempt} Log`
    : 'Interaction Log'

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="z-100 m-0! flex! h-screen! w-screen! items-center! justify-center! overflow-y-auto! bg-black/60! p-4! backdrop-blur-sm!">
        <section className="flex h-[80vh] w-[70vw] max-w-5xl flex-col rounded-xl bg-surface-elevated text-foreground shadow-[0_16px_48px_rgba(0,0,0,0.3)]">
          <header className="flex items-center justify-between border-b border-border-subtle px-5 py-4">
            <div className="text-base font-semibold">{title}</div>
            <button
              type="button"
              className="rounded px-1.5 py-1 text-sm transition-colors hover:bg-surface-alt"
              onClick={onClose}
              aria-label="Close log dialog"
            >
              ✕
            </button>
          </header>

          <div className="min-h-0 flex-1 px-4 pb-4">
            <pre
              ref={logBodyRef}
              className="h-full overflow-auto rounded-lg bg-background p-4 font-mono text-xs leading-relaxed text-foreground"
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
                <div className="mt-2 text-xs">
                  Error: {selectedInteraction.error || contentQuery.data?.error}
                </div>
              )}
          </div>

          <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border-subtle px-5 py-3 text-xs text-muted">
            <span>
              Tokens: {formatTokenCount(selectedInteraction?.input_tokens)} in /{' '}
              {formatTokenCount(selectedInteraction?.output_tokens)} out
            </span>
            <span>Cost: {formatCost(selectedInteraction?.estimated_cost)}</span>
            <span>
              Duration:{' '}
              {formatDuration(
                contentQuery.data?.duration_ms ??
                  selectedInteraction?.duration_ms,
              )}
            </span>
            {stream.isStreaming && (
              <span className="text-emerald-500">Streaming</span>
            )}
          </footer>
        </section>
      </DialogContent>
    </Dialog>
  )
}
