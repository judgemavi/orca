import { Check } from 'lucide-react'

export type TimelinePhaseState = 'pending' | 'active' | 'completed' | 'failed'
export type TimelinePhaseId = 'planning' | 'execution' | 'merge'

const PHASE_LABELS: Record<TimelinePhaseId, string> = {
  planning: 'Planning',
  execution: 'Execution',
  merge: 'Merge',
}

interface Props {
  phase: TimelinePhaseId
  state: TimelinePhaseState
  selected: boolean
  summary?: string
  onSelect: (phase: TimelinePhaseId) => void
}

export function TimelinePhase({
  phase,
  state,
  selected,
  summary,
  onSelect,
}: Props) {
  const isCompleted = state === 'completed'
  const isActive = state === 'active'
  const isPending = state === 'pending'
  const isFailed = state === 'failed'

  return (
    <button
      type="button"
      className="group flex min-w-0 items-center gap-2 py-1 text-left"
      onClick={() => onSelect(phase)}
      aria-current={selected ? 'step' : undefined}
    >
      <span
        className={[
          'relative inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full',
          isCompleted
            ? 'bg-success text-white'
            : isActive
              ? 'bg-accent text-white'
              : isFailed
                ? 'bg-danger text-white'
                : 'border border-border-subtle bg-transparent',
        ].join(' ')}
      >
        {isActive && (
          <span
            className="absolute inset-0 rounded-full border border-accent/70 animate-ping"
            aria-hidden
          />
        )}
        {isCompleted && <Check size={11} strokeWidth={3} />}
      </span>
      <span className="min-w-0">
        <span
          className={[
            'block text-xs leading-4',
            isActive
              ? 'font-medium text-foreground'
              : isFailed
                ? 'text-danger'
                : isPending
                  ? 'text-muted'
                  : 'text-muted',
          ].join(' ')}
        >
          {PHASE_LABELS[phase]}
        </span>
        {isCompleted && !selected && summary ? (
          <span className="block truncate text-[11px] leading-4 text-muted">
            {summary}
          </span>
        ) : null}
      </span>
    </button>
  )
}
