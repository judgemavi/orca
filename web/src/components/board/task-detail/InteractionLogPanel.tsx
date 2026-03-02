import { useEffect, useMemo, useRef } from 'react'
import * as Dialog from '@radix-ui/react-dialog'

import {
  useInteractionContent,
  useInteractionsQuery,
  useInteractionStream,
} from './useInteractions'
import { INTERACTION_STATUSES, PHASE_LABELS } from '../../../lib/phases'

interface Props {
  taskId: string
  interactionId: string
  onClose: () => void
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
    Boolean(
      selectedInteraction &&
        selectedInteraction.status === INTERACTION_STATUSES.running,
    ),
  )

  const content =
    selectedInteraction?.status === INTERACTION_STATUSES.running
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
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-100 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content className="fixed inset-0 z-100 flex items-center justify-center p-4">
          <section className="flex h-[80vh] w-[70vw] max-w-5xl flex-col rounded-xl bg-surface-elevated text-foreground shadow-[0_16px_48px_rgba(0,0,0,0.3)]">
            <header className="flex items-center justify-between border-b border-border-subtle px-5 py-4">
              <Dialog.Title className="text-base font-semibold">
                {title}
              </Dialog.Title>
              <Dialog.Close
                className="rounded px-1.5 py-1 text-sm transition-colors hover:bg-surface-alt"
                aria-label="Close log dialog"
              >
                ✕
              </Dialog.Close>
            </header>

            <div className="min-h-0 flex-1 px-4 pb-4">
              <pre
                ref={logBodyRef}
                className="h-full overflow-auto rounded-lg bg-background p-4 font-mono text-xs leading-relaxed text-foreground"
              >
                {!selectedInteraction
                  ? 'Interaction not found.'
                  : content ||
                    (selectedInteraction.status === INTERACTION_STATUSES.running
                      ? 'Waiting for streaming output...'
                      : 'No content.')}
              </pre>

              {selectedInteraction?.status === INTERACTION_STATUSES.failed &&
                (selectedInteraction.error || contentQuery.data?.error) && (
                  <div className="mt-2 text-xs">
                    Error:{' '}
                    {selectedInteraction.error || contentQuery.data?.error}
                  </div>
                )}
            </div>

            <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border-subtle px-5 py-3 text-xs text-muted">
              <span>
                Tokens: {formatTokenCount(selectedInteraction?.input_tokens)} in
                / {formatTokenCount(selectedInteraction?.output_tokens)} out
              </span>
              <span>
                Cost: {formatCost(selectedInteraction?.estimated_cost)}
              </span>
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
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
