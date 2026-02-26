import { useEffect, useRef } from 'react'
import type { WSEvent } from '../types'

type Listener = (event: WSEvent) => void

const listeners = new Set<Listener>()

export const wsEvents = {
  emit(event: WSEvent) {
    listeners.forEach((fn) => fn(event))
  },
}

export function useWSSubscribe(callback: Listener) {
  const ref = useRef(callback)
  ref.current = callback
  useEffect(() => {
    const fn: Listener = (e) => ref.current(e)
    listeners.add(fn)
    return () => { listeners.delete(fn) }
  }, [])
}
