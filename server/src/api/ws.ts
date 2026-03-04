export interface BroadcastEvent {
  type: string
  timestamp: string
  data: unknown
}

export type EventSink = {
  broadcast: (type: string, data: unknown) => void
  list: (limit?: number) => BroadcastEvent[]
  alerts: (limit?: number) => BroadcastEvent[]
  subscribe: (listener: (event: BroadcastEvent) => void) => () => void
}

export function createEventSink(): EventSink {
  const events: BroadcastEvent[] = []
  const listeners = new Set<(event: BroadcastEvent) => void>()

  const push = (event: BroadcastEvent) => {
    events.push(event)
    if (events.length > 1_000) {
      events.splice(0, events.length - 1_000)
    }
  }

  return {
    broadcast(type: string, data: unknown) {
      const event: BroadcastEvent = {
        type,
        timestamp: new Date().toISOString(),
        data,
      }
      push(event)
      for (const listener of listeners) {
        try {
          listener(event)
        } catch {
          // Ignore listener errors.
        }
      }
      console.log('[ws-event]', type, data)
    },
    list(limit = 100) {
      const size = Math.max(1, Math.min(limit, 500))
      return events.slice(-size)
    },
    alerts(limit = 100) {
      const size = Math.max(1, Math.min(limit, 500))
      return events
        .filter((event) => event.type.includes('failed') || event.type === 'monitor.alert')
        .slice(-size)
    },
    subscribe(listener: (event: BroadcastEvent) => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
