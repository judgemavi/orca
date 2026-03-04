import { useEffect, useRef } from 'react';
import type { WSEvent } from '../types';
import { subscribeWS } from '../ws';

export function useWebSocket(onEvent: (event: WSEvent) => void) {
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    return subscribeWS((event) => onEventRef.current(event));
  }, []);
}
