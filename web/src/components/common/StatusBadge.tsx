import type { Task } from '../../types';

const TONES: Record<string, { badge: string; dot: string }> = {
  pending: {
    badge: 'bg-slate-500/20 text-slate-700',
    dot: 'bg-slate-600',
  },
  planned: {
    badge: 'bg-indigo-500/20 text-indigo-700',
    dot: 'bg-indigo-600',
  },
  running: {
    badge: 'bg-blue-500/20 text-blue-700',
    dot: 'bg-blue-600',
  },
  stopped: {
    badge: 'bg-yellow-500/20 text-yellow-700',
    dot: 'bg-yellow-600',
  },
  review: {
    badge: 'bg-amber-500/20 text-amber-700',
    dot: 'bg-amber-600',
  },
  approved: {
    badge: 'bg-emerald-500/20 text-emerald-700',
    dot: 'bg-emerald-600',
  },
  broken_down: {
    badge: 'bg-orange-500/20 text-orange-700',
    dot: 'bg-orange-600',
  },
  merged: {
    badge: 'bg-emerald-500/20 text-emerald-700',
    dot: 'bg-emerald-600',
  },
  failed: {
    badge: 'bg-rose-500/20 text-rose-700',
    dot: 'bg-rose-600',
  },
};

const SIZES = {
  sm: {
    badge: 'gap-2 rounded-md px-2 py-0.5 text-xs',
    dot: 'h-1.5 w-1.5',
  },
  lg: {
    badge: 'gap-2 rounded-md px-2.5 py-1 text-sm',
    dot: 'h-2.5 w-2.5',
  },
} as const;

export function StatusBadge({
  status,
  size = 'sm',
}: {
  status: Task['status'] | string;
  size?: keyof typeof SIZES;
}) {
  const tone = TONES[status] ?? TONES.pending;
  const scale = SIZES[size];
  return (
    <span
      className={`inline-flex items-center font-medium tracking-wide ${tone.badge} ${scale.badge}`}
    >
      <span className={`rounded-full ${tone.dot} ${scale.dot}`} />
      {status}
    </span>
  );
}
