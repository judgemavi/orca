import type { WSEvent } from './types'

export function connectWS(onEvent: (event: WSEvent) => void): WebSocket {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const ws = new WebSocket(`${protocol}//${window.location.host}/api/v1/ws`)

  ws.onmessage = (e) => {
    const event: WSEvent = JSON.parse(e.data)
    onEvent(event)
  }

  ws.onclose = () => {
    setTimeout(() => connectWS(onEvent), 3000)
  }

  return ws
}
