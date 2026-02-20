import { useState } from 'react'
import { Dialog, DialogContent } from '@tiny-bits/react-dialog'

interface Props {
  open: boolean
  message: string
  onContinue: () => Promise<void>
  onAbort: () => Promise<void>
}

export function AutopilotConfirmDialog({
  open,
  message,
  onContinue,
  onAbort,
}: Props) {
  const [loading, setLoading] = useState<'continue' | 'abort' | null>(null)

  if (!open) return null

  const runAction = async (action: 'continue' | 'abort') => {
    setLoading(action)
    try {
      if (action === 'continue') {
        await onContinue()
      } else {
        await onAbort()
      }
    } finally {
      setLoading(null)
    }
  }

  return (
    <Dialog open={open} modal>
      <DialogContent className="w-[min(480px,calc(100vw-40px))] rounded-lg border border-border bg-[var(--bg-primary)] p-0 shadow-[0_16px_48px_rgba(15,23,42,0.3)]">
        <div className="flex flex-col gap-2.5 p-5 max-sm:p-4">
          <h2 className="text-lg font-bold text-red-900">
            Autopilot needs your input
          </h2>
          <p className="rounded-lg border border-red-200 bg-red-50 p-2.5 text-sm leading-[1.4] text-red-900">
            "{message}"
          </p>
          <p className="text-sm text-[var(--text-secondary)]">
            Do you want to continue or abort?
          </p>
          <div className="mt-1.5 flex justify-end gap-2 max-sm:flex-col-reverse">
            <button
              type="button"
              className="rounded-lg border border-[var(--status-failed)] bg-white px-3 py-2 text-[13px] font-semibold text-[var(--status-failed)] hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60 max-sm:w-full"
              onClick={() => {
                void runAction('abort')
              }}
              disabled={loading !== null}
            >
              {loading === 'abort' ? 'Aborting...' : 'Abort'}
            </button>
            <button
              type="button"
              className="rounded-lg border border-accent bg-accent px-3 py-2 text-[13px] font-semibold text-white hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-60 max-sm:w-full"
              onClick={() => {
                void runAction('continue')
              }}
              disabled={loading !== null}
            >
              {loading === 'continue' ? 'Continuing...' : 'Continue'}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
