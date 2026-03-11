import { log } from '../shared/logger';
import type { KnownWSEventType } from '../types/events';

export interface BroadcastEvent {
  id: number;
  type: KnownWSEventType;
  timestamp: string;
  data: unknown;
}

export type EventSink = {
  broadcast: (type: KnownWSEventType, data: unknown) => void;
  list: (limit?: number) => BroadcastEvent[];
  alerts: (limit?: number) => BroadcastEvent[];
  since: (lastId: number, limit?: number) => BroadcastEvent[];
  subscribe: (listener: (event: BroadcastEvent) => void) => () => void;
};

export function createEventSink(): EventSink {
  const events: BroadcastEvent[] = [];
  const listeners = new Set<(event: BroadcastEvent) => void>();
  let nextId = 1;

  const push = (event: BroadcastEvent) => {
    events.push(event);
    if (events.length > 1_000) {
      events.splice(0, events.length - 1_000);
    }
  };

  return {
    broadcast(type: KnownWSEventType, data: unknown) {
      const event: BroadcastEvent = {
        id: nextId++,
        type,
        timestamp: new Date().toISOString(),
        data,
      };
      push(event);
      for (const listener of listeners) {
        try {
          listener(event);
        } catch {
          // Ignore listener errors.
        }
      }
      log.debug('ws-event', { type, data });
    },
    list(limit = 100) {
      const size = Math.max(1, Math.min(limit, 500));
      return events.slice(-size);
    },
    alerts(limit = 100) {
      const size = Math.max(1, Math.min(limit, 500));
      return events
        .filter(
          (event) =>
            event.type.includes('failed') || event.type === 'monitor.alert',
        )
        .slice(-size);
    },
    since(lastId: number, limit = 500) {
      const size = Math.max(1, Math.min(limit, 1000));
      return events.filter((e) => e.id > lastId).slice(-size);
    },
    subscribe(listener: (event: BroadcastEvent) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
