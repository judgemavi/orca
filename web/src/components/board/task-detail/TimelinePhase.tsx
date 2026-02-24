import { Check } from 'lucide-react'
import type { ReactNode } from 'react'

export type TimelinePhaseState = 'disabled' | 'active' | 'completed'
export type TimelinePhaseId = 'planning' | 'execution' | 'merge'

const PHASE_LABELS: Record<TimelinePhaseId, string> = {
  planning: 'Planning',
  execution: 'Execution',
  merge: 'Merge',
}

interface Props {
  phase: TimelinePhaseId
  state: TimelinePhaseState
  headerAction?: ReactNode
  children: ReactNode
}

export function TimelinePhase({ phase, state, headerAction, children }: Props) {
  const isDisabled = state === 'disabled'
  const isActive = state === 'active'
  const isCompleted = state === 'completed'

  return (
    <section
      className={[
        'relative mb-4 border-l pl-6',
        isDisabled
          ? 'pointer-events-none border-dashed border-[var(--border)] opacity-45'
          : 'border-[var(--border)]',
      ].join(' ')}
      aria-disabled={isDisabled}
    >
      <div
        className={[
          'absolute -left-[9px] top-1 flex h-4 w-4 items-center justify-center rounded-full border',
          isActive
            ? 'animate-pulse border-[var(--accent)] bg-[var(--accent)]'
            : isCompleted
              ? 'border-emerald-500 bg-emerald-500 text-white'
              : 'border-[var(--border)] bg-[var(--bg-primary)]',
        ].join(' ')}
      >
        {isCompleted && <Check size={11} strokeWidth={3} />}
      </div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div
          className={[
            'text-xs font-semibold uppercase tracking-[0.06em]',
            isActive ? 'text-[var(--accent)]' : 'text-[var(--text-secondary)]',
          ].join(' ')}
        >
          {PHASE_LABELS[phase]}
        </div>
        {headerAction ? <div>{headerAction}</div> : null}
      </div>
      {children}
    </section>
  )
}
