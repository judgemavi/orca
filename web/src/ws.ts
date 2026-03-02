// WebSocket client. Auto-reconnects. Broadcasts KnownWSEvent to listeners.

import type { WSEvent } from './types'

type Listener = (event: WSEvent) => void

let ws: WebSocket | null = null
const listeners = new Set<Listener>()
let reconnectTimer: ReturnType<typeof setTimeout> | null = null

function getURL() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/api/v1/ws`
}

function connect() {
  if (
    ws &&
    (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)
  ) {
    return
  }

  ws = new WebSocket(getURL())

  ws.onmessage = (e) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(e.data)
    } catch {
      return
    }
    if (!parsed || typeof parsed !== 'object') return

    const eventObj = parsed as Record<string, unknown>
    const type = typeof eventObj.type === 'string' ? eventObj.type : ''
    if (!type) return

    const event: WSEvent = {
      type,
      timestamp:
        typeof eventObj.timestamp === 'string' ? eventObj.timestamp : '',
      data:
        eventObj.data && typeof eventObj.data === 'object'
          ? (eventObj.data as Record<string, unknown>)
          : {},
    }
    listeners.forEach((fn) => fn(event))
  }

  ws.onclose = () => {
    ws = null
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectTimer = setTimeout(connect, 3000)
  }
}

export function subscribeWS(listener: Listener): () => void {
  listeners.add(listener)
  if (!ws || ws.readyState === WebSocket.CLOSED) {
    connect()
  }
  return () => {
    listeners.delete(listener)
  }
}
