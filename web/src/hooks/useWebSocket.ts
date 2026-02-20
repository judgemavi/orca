import { useEffect, useRef } from 'react'
import { connectWS } from '../ws'
import type { WSEvent } from '../types'

export function useWebSocket(onEvent: (event: WSEvent) => void) {
  const wsRef = useRef<WebSocket | null>(null)
  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent

  useEffect(() => {
    wsRef.current = connectWS((event) => onEventRef.current(event))
    return () => {
      wsRef.current?.close()
    }
  }, [])

  return wsRef
}
