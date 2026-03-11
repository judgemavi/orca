import { INTERACTION_STATUSES } from '@orca/server/types';
import * as Accordion from '@radix-ui/react-accordion';
import { Brain, Check, Dot, Hammer, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { formatDuration } from '../lib/format';
import type { InteractionStub } from '../types';
import { Button } from './Button';
import { InteractionLogPanel } from './InteractionLogPanel';

interface Props {
  taskId: string;
  stub: InteractionStub;
  type?: string;
  name?: string;
  collapsible?: boolean;
  showDiffSummary?: boolean;
  canReset?: boolean;
  onReset?: (interactionId: string) => void;
  onResetAndRun?: (interactionId: string) => void;
  children?: ReactNode;
}

function statusIcon(status: InteractionStub['status'], type?: string) {
  if (status === INTERACTION_STATUSES.completed) return <Check size={14} />;
  if (status === INTERACTION_STATUSES.failed) {
    if (type === 'decision') return <Hammer size={14} />;
    return <X size={14} />;
  }
  return <Dot size={14} />;
}

function typeBadgeTone(type: string | undefined): string {
  const normalized = type?.trim().toLowerCase();
  if (normalized === 'context')
    return 'border-indigo-500/35 bg-indigo-500/15 text-indigo-300';
  if (normalized === 'code')
    return 'border-emerald-500/35 bg-emerald-500/15 text-emerald-300';
  if (normalized === 'decision')
    return 'border-amber-500/35 bg-amber-500/15 text-amber-300';
  if (normalized === 'evaluate')
    return 'border-cyan-500/35 bg-cyan-500/15 text-cyan-300';
  if (normalized === 'breakdown')
    return 'border-orange-500/35 bg-orange-500/15 text-orange-300';
  if (normalized === 'merge')
    return 'border-purple-500/35 bg-purple-500/15 text-purple-300';
  return 'border-slate-500/35 bg-slate-500/15 text-slate-300';
}

export function InteractionEntry({
  taskId,
  stub,
  type,
  name,
  collapsible = false,
  showDiffSummary = false,
  canReset = false,
  onReset,
  onResetAndRun,
  children,
}: Props) {
  const alwaysExpanded = stub.status === INTERACTION_STATUSES.running;
  const isRunning = stub.status === INTERACTION_STATUSES.running;
  const typeLabel = (name ?? type)?.trim();
  const diffSummary = showDiffSummary ? stub.diffSummary : null;
  const rowClass = [
    'flex w-full items-center justify-between gap-2 rounded-md px-1 py-0.5 text-left transition-colors',
    alwaysExpanded ? '' : 'cursor-pointer hover:bg-surface/50',
  ]
    .filter(Boolean)
    .join(' ');
  const triggerDisabled = !collapsible || alwaysExpanded;
  const headerContent = (
    <button type="button" className={rowClass} disabled={triggerDisabled}>
      <div className="flex min-w-0 items-center gap-2 text-xs">
        {collapsible && !alwaysExpanded && (
          <span
            className="font-mono text-[11px] group-data-[state=open]:hidden"
            aria-hidden
          >
            ▸
          </span>
        )}
        {collapsible && !alwaysExpanded && (
          <span
            className="font-mono text-[11px] group-data-[state=closed]:hidden"
            aria-hidden
          >
            ▾
          </span>
        )}
        <span
          className={[
            'inline-flex h-4 w-4 items-center justify-center rounded-full border text-xs',
            stub.status === INTERACTION_STATUSES.completed
              ? 'border-emerald-500 text-emerald-500'
              : stub.status === INTERACTION_STATUSES.failed
                ? stub.type === 'decision'
                  ? 'border-amber-500 text-amber-500'
                  : 'border-danger text-danger'
                : 'animate-pulse border-accent text-accent',
          ].join(' ')}
          aria-hidden
        >
          {statusIcon(stub.status, stub.type)}
        </span>
        <span className="font-mono">#{stub.attempt}</span>
        {typeLabel && (
          <span
            className={[
              'rounded border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.05em]',
              typeBadgeTone(type),
            ].join(' ')}
          >
            [{typeLabel.toUpperCase()}]
          </span>
        )}
        <span className="truncate">{stub.tool || '-'}</span>
        <span className="font-mono">
          {isRunning ? '-' : formatDuration(stub.durationMs)}
        </span>
        {stub.memoryCount != null && stub.memoryCount > 0 && (
          <span
            className="inline-flex items-center gap-0.5 text-violet-400"
            title={`${stub.memoryCount} memory entries used`}
          >
            <Brain size={12} />
            <span className="font-mono text-[10px]">{stub.memoryCount}</span>
          </span>
        )}
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
  );

  return (
    <Accordion.Item
      value={stub.id}
      className="group rounded-lg bg-surface-alt p-4"
    >
      <div className="flex items-center justify-between gap-2">
        <Accordion.Header className="min-w-0 flex-1">
          {collapsible ? (
            <Accordion.Trigger asChild disabled={triggerDisabled}>
              {headerContent}
            </Accordion.Trigger>
          ) : (
            headerContent
          )}
        </Accordion.Header>

        <div className="flex items-center gap-1">
          {canReset && onReset && (
            <Button
              className="px-2 py-0.5 text-xs"
              onClick={(event) => {
                event.stopPropagation();
                if (
                  window.confirm(
                    `Reset to interaction #${stub.attempt}? Later interactions will be deleted.`,
                  )
                ) {
                  onReset(stub.id);
                }
              }}
              aria-label="Reset to this interaction"
            >
              reset
            </Button>
          )}
          {canReset && onResetAndRun && (
            <Button
              className="px-2 py-0.5 text-xs"
              onClick={(event) => {
                event.stopPropagation();
                if (
                  window.confirm(
                    `Reset and re-run from interaction #${stub.attempt}? Later interactions will be deleted.`,
                  )
                ) {
                  onResetAndRun(stub.id);
                }
              }}
              aria-label="Reset and re-run from this interaction"
            >
              reset &amp; run
            </Button>
          )}
          <InteractionLogPanel taskId={taskId} interactionId={stub.id} />
        </div>
      </div>

      {children && (
        <Accordion.Content className="overflow-hidden data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down">
          <div
            className={[
              'mt-3 flex flex-col gap-2',
              isRunning ? 'opacity-95' : '',
            ].join(' ')}
          >
            {children}
          </div>
        </Accordion.Content>
      )}
    </Accordion.Item>
  );
}
