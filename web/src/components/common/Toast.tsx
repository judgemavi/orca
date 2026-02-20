import { useEffect } from 'react'

interface Props {
  message: string | null
  type?: 'error'
  onClose: () => void
  durationMs?: number
}

export function Toast({
  message,
  type = 'error',
  onClose,
  durationMs = 3000,
}: Props) {
  useEffect(() => {
    if (!message) return
    const timer = window.setTimeout(onClose, durationMs)
    return () => window.clearTimeout(timer)
  }, [message, durationMs, onClose])

  if (!message) return null

  const tones: Record<NonNullable<Props['type']>, string> = {
    error: 'bg-red-700',
  }

  return (
    <div
      className={`fixed bottom-5 left-1/2 z-[2000] w-[min(560px,calc(100vw-24px))] -translate-x-1/2 rounded-lg px-3.5 py-2.5 text-sm text-white shadow-[0_10px_26px_rgba(15,23,42,0.28)] ${tones[type]}`}
      role="alert"
    >
      {message}
    </div>
  )
}
