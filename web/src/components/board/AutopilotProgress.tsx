import { useMemo, useState } from 'react'
import type { AutopilotEvent } from '../../hooks/useAutopilot'

interface Props {
  goal: string
  events: AutopilotEvent[]
  onStop: () => Promise<void>
}

function statusIcon(type: string): string {
  if (type === 'autopilot.escalation' || type === 'autopilot.review_complete')
    return '⚠'
  if (type === 'autopilot.completed' || type === 'autopilot.stopped') return '✓'
  if (type === 'autopilot.error') return '✕'
  return '●'
}

function isInProgressType(type: string): boolean {
  return !(
    type === 'autopilot.completed' ||
    type === 'autopilot.stopped' ||
    type === 'autopilot.error' ||
    type === 'autopilot.escalation' ||
    type === 'autopilot.review_complete'
  )
}

export function AutopilotProgress({ goal, events, onStop }: Props) {
  const [stopping, setStopping] = useState(false)

  const visibleEvents = useMemo(() => events.slice(-40), [events])

  const handleStop = async () => {
    setStopping(true)
    try {
      await onStop()
    } finally {
      setStopping(false)
    }
  }

  return (
    <section className="flex flex-col gap-2.5 border border-[#2c3f69] border-l-4 border-l-[#4f8bff] bg-gradient-to-b from-[#131b31] to-[#101725] p-3 text-[#f8fbff]">
      <div className="flex items-center justify-between gap-3 max-[760px]:flex-col max-[760px]:items-start">
        <div>
          <h3 className="text-sm font-bold">
            Autopilot running - "{goal || 'Working'}"
          </h3>
        </div>
        <button
          type="button"
          className="whitespace-nowrap rounded-sm border border-[#ff8f8f] bg-[#3a1b22] px-2.5 py-1.5 text-xs font-semibold text-[#ffd9d9] hover:bg-[#4d202c] disabled:cursor-not-allowed disabled:opacity-60 max-[760px]:w-full"
          onClick={handleStop}
          disabled={stopping}
        >
          {stopping ? 'Stopping...' : 'Stop Autopilot'}
        </button>
      </div>

      <div className="flex max-h-[180px] flex-col gap-1.5 overflow-y-auto rounded-lg border border-[#233355] bg-[#0b1220] p-2.5 font-mono text-xs">
        {visibleEvents.length === 0 && (
          <div className="text-[#8ba6cd]">● Initializing autopilot...</div>
        )}
        {visibleEvents.map((event, index) => (
          <div
            key={`${event.timestamp}-${event.type}-${index}`}
            className="grid grid-cols-[16px_1fr] items-start gap-2"
          >
            <span
              className={[
                'text-[#7bb1ff]',
                isInProgressType(event.type) ? 'animate-spin' : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              {statusIcon(event.type)}
            </span>
            <span className="break-words leading-[1.4] text-[#d3e8ff]">
              {event.message}
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}
