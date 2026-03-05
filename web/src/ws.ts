// SSE client. Auto-reconnects via EventSource. Broadcasts WSEvent to listeners.

import type { WSEvent } from './types';

type Listener = (event: WSEvent) => void;

let es: EventSource | null = null;
const listeners = new Set<Listener>();

function getURL() {
  return '/api/v1/events';
}

function dispatch(parsed: Record<string, unknown>) {
  const type = typeof parsed.type === 'string' ? parsed.type : '';
  if (!type) return;

  const event: WSEvent = {
    type,
    timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : '',
    data:
      parsed.data && typeof parsed.data === 'object'
        ? (parsed.data as Record<string, unknown>)
        : {},
  };
  for (const fn of listeners) fn(event);
}

function connect() {
  if (es) return;

  es = new EventSource(getURL());

  es.onmessage = (e) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(e.data);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== 'object') return;
    dispatch(parsed as Record<string, unknown>);
  };

  es.onerror = () => {
    // EventSource auto-reconnects; clean up ref so we can track state
    es?.close();
    es = null;
    setTimeout(connect, 3000);
  };
}

export function subscribeWS(listener: Listener): () => void {
  listeners.add(listener);
  if (!es) connect();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && es) {
      es.close();
      es = null;
    }
  };
}
