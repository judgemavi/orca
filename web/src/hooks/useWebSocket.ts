import { useEffect, useRef } from 'react'
import { subscribeWS } from '../ws'
import type { WSEvent } from '../types'

export function useWebSocket(onEvent: (event: WSEvent) => void) {
  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent

  useEffect(() => {
    return subscribeWS((event) => onEventRef.current(event))
  }, [])
}
