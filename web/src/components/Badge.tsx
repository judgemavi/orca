import clsx from 'clsx';
import type { ComponentProps } from 'react';

export type BadgeVariant =
  | 'default'
  | 'blue'
  | 'emerald'
  | 'amber'
  | 'rose'
  | 'indigo'
  | 'cyan'
  | 'violet'
  | 'slate'
  | 'orange'
  | 'yellow';

const VARIANT_CLASSES: Record<BadgeVariant, string> = {
  default: 'bg-surface-alt text-muted',
  blue: 'bg-blue-500/15 text-blue-700 dark:text-blue-300',
  emerald: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  amber: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  rose: 'bg-rose-500/15 text-rose-700 dark:text-rose-300',
  indigo: 'bg-indigo-500/15 text-indigo-700 dark:text-indigo-300',
  cyan: 'bg-cyan-500/15 text-cyan-700 dark:text-cyan-300',
  violet: 'bg-violet-500/15 text-violet-700 dark:text-violet-300',
  slate: 'bg-slate-500/15 text-slate-700 dark:text-slate-300',
  orange: 'bg-orange-500/15 text-orange-700 dark:text-orange-300',
  yellow: 'bg-yellow-500/15 text-yellow-700 dark:text-yellow-300',
};

interface BadgeProps extends ComponentProps<'span'> {
  variant?: BadgeVariant;
  size?: 'sm' | 'lg';
}

export function Badge({
  variant = 'default',
  size = 'sm',
  className,
  children,
  ...props
}: BadgeProps) {
  return (
    <span
      className={clsx(
        'inline-flex items-center rounded font-medium',
        VARIANT_CLASSES[variant],
        size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-1 text-sm',
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}
