import type { Task } from '../types';
import { Badge, type BadgeVariant } from './Badge';

const STATUS_VARIANT: Record<string, BadgeVariant> = {
  pending: 'slate',
  planned: 'indigo',
  running: 'blue',
  stopped: 'yellow',
  review: 'amber',
  approved: 'emerald',
  broken_down: 'orange',
  merged: 'emerald',
  failed: 'rose',
};

export function StatusBadge({
  status,
  size = 'sm',
}: {
  status: Task['status'] | string;
  size?: 'sm' | 'lg';
}) {
  return (
    <Badge variant={STATUS_VARIANT[status] ?? 'slate'} size={size}>
      {status}
    </Badge>
  );
}
