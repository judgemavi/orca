import type { BroadcastEvent } from '../api/ws';

export function monitorAlerts(
  events: BroadcastEvent[],
  limit = 100,
): BroadcastEvent[] {
  const size = Math.max(1, Math.min(limit, 500));
  return events
    .filter(
      (event) =>
        event.type.includes('failed') ||
        event.type === 'monitor.alert' ||
        event.type === 'monitor.conflict' ||
        event.type === 'monitor.stuck',
    )
    .slice(-size);
}
