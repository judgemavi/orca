import { nanoid } from 'nanoid';
import type { KnownWSEventType } from '../../types/events';
import type { EventSink } from '../ws';

export function broadcast(
  sink: EventSink,
  type: KnownWSEventType,
  data: Record<string, unknown>,
): void {
  sink.broadcast(type, {
    ...data,
    timestamp: new Date().toISOString(),
  });
}

export function asBoolean(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

export function randomID(prefix = ''): string {
  return prefix ? `${prefix}-${nanoid()}` : nanoid();
}
