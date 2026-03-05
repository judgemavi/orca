// SSE client. Auto-reconnects with exponential backoff. Broadcasts WSEvent to listeners.

import type { WSEvent } from './types';

type Listener = (event: WSEvent) => void;

let es: EventSource | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30000;
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

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
}

function connect() {
  if (es) return;
  if (listeners.size === 0) return;

  es = new EventSource(getURL());

  es.onopen = () => {
    reconnectDelay = 1000;
  };

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
    es?.close();
    es = null;
    scheduleReconnect();
  };
}

export function subscribeWS(listener: Listener): () => void {
  listeners.add(listener);
  if (!es && !reconnectTimer) connect();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (es) {
        es.close();
        es = null;
      }
      reconnectDelay = 1000;
    }
  };
}
