import { INTERACTION_STATUSES } from '@orca/server/types';
import * as Dialog from '@radix-ui/react-dialog';
import { useMemo } from 'react';
import {
  useInteractionContent,
  useInteractionStream,
  useInteractionsQuery,
} from '../hooks/useInteractions';
import { LogViewer } from './LogViewer';

interface Props {
  taskId: string;
  interactionId: string;
  onClose: () => void;
}

import { formatCost, formatDuration, formatTokens } from '../lib/format';

export function InteractionLogPanel({ taskId, interactionId, onClose }: Props) {
  const interactionsQuery = useInteractionsQuery(taskId);

  const selectedInteraction = useMemo(
    () =>
      (interactionsQuery.data ?? []).find(
        (item) => item.id === interactionId,
      ) ?? null,
    [interactionId, interactionsQuery.data],
  );

  const contentQuery = useInteractionContent(taskId, interactionId);

  const stream = useInteractionStream(
    taskId,
    interactionId,
    Boolean(
      selectedInteraction &&
        selectedInteraction.status === INTERACTION_STATUSES.running,
    ),
  );

  const content =
    selectedInteraction?.status === INTERACTION_STATUSES.running
      ? stream.content || contentQuery.data?.rawContent || ''
      : contentQuery.data?.rawContent || '';

  const type = selectedInteraction?.type ?? '';
  const titlePrefix = type
    ? type.charAt(0).toUpperCase() + type.slice(1)
    : 'Interaction';
  const title = selectedInteraction
    ? `${titlePrefix} #${selectedInteraction.attempt} Log`
    : 'Interaction Log';

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
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
              <LogViewer
                content={selectedInteraction ? content : ''}
                placeholder={
                  !selectedInteraction
                    ? 'Interaction not found.'
                    : selectedInteraction.status ===
                        INTERACTION_STATUSES.running
                      ? 'Waiting for streaming output...'
                      : 'No content.'
                }
              />

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
                Tokens: {formatTokens(selectedInteraction?.inputTokens)} in /{' '}
                {formatTokens(selectedInteraction?.outputTokens)} out
              </span>
              <span>
                Cost: {formatCost(selectedInteraction?.estimatedCost)}
              </span>
              <span>
                Duration:{' '}
                {formatDuration(
                  contentQuery.data?.durationMs ??
                    selectedInteraction?.durationMs,
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
  );
}
