import type { Task } from '../../types'

const ICONS: Record<string, string> = {
  pending: '\u25CB',
  planned: '\u25CE',
  running: '\u25CF',
  approved: '\u2713',
  merged: '\u2713',
  failed: '\u2717',
}

export function StatusBadge({ status }: { status: Task['status'] | string }) {
  const tones: Record<string, string> = {
    pending: 'bg-slate-100 text-slate-600',
    planned: 'bg-indigo-100 text-indigo-700',
    running: 'bg-blue-100 text-blue-700',
    approved: 'bg-emerald-100 text-emerald-700',
    merged: 'bg-emerald-100 text-emerald-700',
    failed: 'bg-rose-100 text-rose-700',
  }
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-xl px-2 py-0.5 text-xs font-medium ${tones[status] ?? 'bg-slate-100 text-slate-600'}`}
    >
      {ICONS[status] ?? '\u25CB'} {status}
    </span>
  )
}

export function StatusIcon({ status }: { status: string }) {
  const colors: Record<string, string> = {
    pending: 'bg-slate-400',
    planned: 'bg-indigo-500',
    running: 'bg-blue-500 animate-pulse',
    approved: 'bg-emerald-500',
    merged: 'bg-emerald-500',
    failed: 'bg-rose-500',
  }
  return (
    <span
      className={`inline-flex h-2.5 w-2.5 shrink-0 rounded-full ${colors[status] ?? 'bg-slate-400'}`}
      title={status}
    />
  )
}
