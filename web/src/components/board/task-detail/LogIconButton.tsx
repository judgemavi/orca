import { FileText } from 'lucide-react'

interface Props {
  count: number
  hasRunning: boolean
  active: boolean
  onClick: () => void
}

export function LogIconButton({ count, hasRunning, active, onClick }: Props) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'relative inline-flex h-7 w-7 items-center justify-center rounded-md border transition-colors',
        active
          ? 'border-[var(--accent)] bg-[var(--accent)]/15 text-[var(--accent)]'
          : 'border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
      ].join(' ')}
      aria-label="Toggle interaction logs"
      title="View interaction logs"
    >
      <FileText size={14} />

      {count > 0 && (
        <span className="absolute -right-2 -top-2 min-w-4 rounded-full bg-[var(--accent)] px-1 text-center text-[10px] font-semibold leading-4 text-white">
          {count}
        </span>
      )}

      {hasRunning && (
        <span className="absolute -bottom-1 -right-1 h-2.5 w-2.5 rounded-full bg-emerald-500 ring-2 ring-[var(--bg-primary)] animate-pulse" />
      )}
    </button>
  )
}
