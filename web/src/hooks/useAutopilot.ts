import { useState, useEffect, useCallback } from 'react'
import { api } from '../api'
import type { WSEvent } from '../types'

export interface AutopilotEvent {
  type: string
  message: string
  timestamp: string
}

interface StartOptions {
  unattended: boolean
  maxSprints: number
}

function eventMessage(event: WSEvent): string {
  const message = event.data.message
  if (typeof message === 'string' && message.length > 0) return message
  return event.type
}

export function useAutopilot() {
  const [running, setRunning] = useState(false)
  const [goal, setGoal] = useState('')
  const [events, setEvents] = useState<AutopilotEvent[]>([])
  const [pendingConfirm, setPendingConfirm] = useState<string | null>(null)

  useEffect(() => {
    api
      .autopilotStatus()
      .then((status) => {
        setRunning(status.autopilot_running)
      })
      .catch(() => {
        setRunning(false)
      })
  }, [])

  const handleWSEvent = useCallback((event: WSEvent) => {
    if (!event.type.startsWith('autopilot.')) return

    if (event.type === 'autopilot.started') {
      setRunning(true)
      const goalValue = event.data.goal
      if (typeof goalValue === 'string') {
        setGoal(goalValue)
      }
      setPendingConfirm(null)
      setEvents([])
      return
    }

    const autopilotEvent: AutopilotEvent = {
      type: event.type,
      message: eventMessage(event),
      timestamp: event.timestamp,
    }

    if (
      event.type === 'autopilot.completed' ||
      event.type === 'autopilot.stopped' ||
      event.type === 'autopilot.error'
    ) {
      setRunning(false)
      setPendingConfirm(null)
      setEvents((prev) => [...prev, autopilotEvent])
      return
    }

    if (event.type === 'autopilot.escalation') {
      setPendingConfirm(autopilotEvent.message || 'Autopilot needs input')
      setEvents((prev) => [...prev, autopilotEvent])
      return
    }

    if (event.type === 'autopilot.review_complete') {
      setPendingConfirm(autopilotEvent.message || 'Review complete - continue?')
      setEvents((prev) => [...prev, autopilotEvent])
      return
    }

    setEvents((prev) => [...prev, autopilotEvent])
  }, [])

  const start = useCallback(async (nextGoal: string, opts: StartOptions) => {
    setGoal(nextGoal)
    setEvents([])
    setPendingConfirm(null)
    setRunning(true)

    try {
      await api.autopilotStart(nextGoal, {
        unattended: opts.unattended,
        max_sprints: opts.maxSprints,
      })
    } catch (error) {
      setRunning(false)
      throw error
    }
  }, [])

  const stop = useCallback(async () => {
    await api.autopilotStop()
  }, [])

  const respond = useCallback(async (cont: boolean) => {
    setPendingConfirm(null)
    await api.autopilotRespond(cont)
  }, [])

  return {
    running,
    goal,
    events,
    pendingConfirm,
    start,
    stop,
    respond,
    handleWSEvent,
  }
}
