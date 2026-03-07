import { INTERACTION_STATUSES } from '@orca/server/types';
import * as Collapsible from '@radix-ui/react-collapsible';
import { Brain, Check, Dot, Hammer, X } from 'lucide-react';
import type { ReactNode } from 'react';
import type { InteractionStub } from '../types';
import { Button } from './Button';
import { useInteractionDetailContext } from './InteractionDetailContext';

interface Props {
  stub: InteractionStub;
  type?: string;
  collapsible?: boolean;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  alwaysExpanded?: boolean;
  showDiffSummary?: boolean;
  children?: ReactNode;
}

import { formatCost, formatDuration } from '../lib/format';

function statusIcon(status: InteractionStub['status'], type?: string) {
  if (status === INTERACTION_STATUSES.completed) return <Check size={14} />;
  if (status === INTERACTION_STATUSES.failed) {
    if (type === 'review') return <Hammer size={14} />;
    return <X size={14} />;
  }
  return <Dot size={14} />;
}

function typeBadgeTone(type: string | undefined): string {
  const normalized = type?.trim().toLowerCase();
  if (normalized === 'plan')
    return 'border-indigo-500/35 bg-indigo-500/15 text-indigo-300';
  if (normalized === 'code')
    return 'border-emerald-500/35 bg-emerald-500/15 text-emerald-300';
  if (normalized === 'review')
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
  stub,
  type,
  collapsible = false,
  expanded = false,
  onExpandedChange,
  alwaysExpanded = false,
  showDiffSummary = false,
  children,
}: Props) {
  const detailContext = useInteractionDetailContext();
  const activeLogId = detailContext?.activeLogId ?? null;
  const onToggleLog = detailContext?.onToggleLog;
  const isRunning = stub.status === INTERACTION_STATUSES.running;
  const typeLabel = type?.trim();
  const open = collapsible ? alwaysExpanded || expanded : true;
  const diffSummary = showDiffSummary ? stub.diffSummary : null;
  const rowClass = [
    'flex w-full items-center justify-between gap-2 rounded-md px-1 py-0.5 text-left transition-colors',
    alwaysExpanded ? '' : 'cursor-pointer hover:bg-surface/50',
  ]
    .filter(Boolean)
    .join(' ');

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
                  stub.status === INTERACTION_STATUSES.completed
                    ? 'border-emerald-500 text-emerald-500'
                    : stub.status === INTERACTION_STATUSES.failed
                      ? stub.type === 'review'
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
                    typeBadgeTone(typeLabel),
                  ].join(' ')}
                >
                  [{typeLabel.toUpperCase()}]
                </span>
              )}
              <span className="truncate">{stub.tool || '-'}</span>
              <span className="font-mono">
                {isRunning ? '-' : formatDuration(stub.durationMs)}
              </span>
              <span className="font-mono">
                {formatCost(stub.estimatedCost)}
              </span>
              {stub.memoryCount != null && stub.memoryCount > 0 && (
                <span
                  className="inline-flex items-center gap-0.5 text-violet-400"
                  title={`${stub.memoryCount} memory entries used`}
                >
                  <Brain size={12} />
                  <span className="font-mono text-[10px]">
                    {stub.memoryCount}
                  </span>
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
        </Collapsible.Trigger>

        {onToggleLog && (
          <Button
            className={[
              'px-2 py-0.5 text-xs',
              activeLogId === stub.id
                ? 'border-accent bg-accent/15 text-accent hover:bg-accent/20'
                : '',
            ].join(' ')}
            onClick={(event) => {
              event.stopPropagation();
              onToggleLog(stub.id);
            }}
            aria-label={
              activeLogId === stub.id
                ? 'Hide interaction log'
                : 'Show interaction log'
            }
          >
            {activeLogId === stub.id ? 'log open' : 'log'}
          </Button>
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
  );
}
