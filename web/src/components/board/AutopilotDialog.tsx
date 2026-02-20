import { useEffect } from 'react'
import { Dialog, DialogContent } from '@tiny-bits/react-dialog'
import { useAutopilotForm } from '../../hooks/forms/useAutopilotForm'

interface Props {
  open: boolean
  budget: number
  onStart: (
    goal: string,
    opts: { unattended: boolean; maxSprints: number },
  ) => void | Promise<void>
  onClose: () => void
}

export function AutopilotDialog({ open, budget, onStart, onClose }: Props) {
  const form = useAutopilotForm({ maxSprints: 3, unattended: false, goal: '' })

  useEffect(() => {
    if (!open) {
      form.reset()
    }
  }, [open, form])

  if (!open) return null

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const cleanedGoal = form.state.values.goal.trim()
    if (!cleanedGoal) return
    await onStart(cleanedGoal, {
      unattended: form.state.values.unattended,
      maxSprints: form.state.values.maxSprints,
    })
  }

  const safeBudget = Number.isFinite(budget) ? budget : 0

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose()
      }}
      modal
    >
      <DialogContent className="w-[min(640px,calc(100vw-40px))] rounded-lg border border-border bg-[var(--bg-primary)] p-0 shadow-[0_16px_48px_rgba(15,23,42,0.25)]">
        <form
          className="flex flex-col gap-3 p-5 max-sm:p-4"
          onSubmit={handleSubmit}
        >
          <h2 className="text-xl font-bold">Start Autopilot</h2>

          <form.Field name="goal">
            {(field) => (
              <>
                <label
                  className="text-xs uppercase tracking-[0.06em] text-[var(--text-secondary)]"
                  htmlFor="autopilot-goal"
                >
                  Goal
                </label>
                <input
                  id="autopilot-goal"
                  className="w-full rounded-lg border border-border bg-[var(--bg-primary)] px-3 py-2.5 text-sm text-[var(--text-primary)] outline-none focus:border-accent focus:outline-2 focus:outline-blue-500/25"
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                  placeholder="Build user authentication flow"
                  autoFocus
                />
              </>
            )}
          </form.Field>

          <section className="flex flex-col gap-1.5 rounded-lg border border-amber-300 bg-amber-50 p-3">
            <p className="text-[13px] font-semibold text-amber-900">
              Autopilot will autonomously:
            </p>
            <ul className="ml-4 grid gap-0.5 text-[13px] text-amber-800">
              <li>Explore your codebase</li>
              <li>Decompose the goal into tasks</li>
              <li>Plan and execute sprints</li>
              <li>Review and integrate changes</li>
            </ul>
            <p className="text-[13px] text-amber-950">
              This will consume LLM tokens and incur costs. Current budget: $
              {safeBudget.toFixed(2)}
            </p>
          </section>

          <div className="flex flex-col gap-2">
            <form.Field name="unattended">
              {(field) => (
                <label className="inline-flex items-center gap-2 text-sm text-[var(--text-primary)]">
                  <input
                    type="checkbox"
                    checked={field.state.value}
                    onChange={(event) =>
                      field.handleChange(event.target.checked)
                    }
                  />
                  Unattended (skip review pauses)
                </label>
              )}
            </form.Field>

            <form.Field name="maxSprints">
              {(field) => (
                <>
                  <label
                    className="text-xs uppercase tracking-[0.06em] text-[var(--text-secondary)]"
                    htmlFor="autopilot-max-sprints"
                  >
                    Max sprints
                  </label>
                  <input
                    id="autopilot-max-sprints"
                    className="w-full max-w-[140px] rounded-lg border border-border bg-[var(--bg-primary)] px-3 py-2.5 text-sm text-[var(--text-primary)] outline-none focus:border-accent focus:outline-2 focus:outline-blue-500/25"
                    type="number"
                    min={1}
                    max={50}
                    value={field.state.value}
                    onChange={(event) => {
                      const nextValue = Number(event.target.value)
                      if (!Number.isNaN(nextValue)) {
                        field.handleChange(
                          Math.min(50, Math.max(1, Math.round(nextValue))),
                        )
                      }
                    }}
                  />
                </>
              )}
            </form.Field>
          </div>

          <div className="mt-1 flex justify-end gap-2 max-sm:flex-col-reverse">
            <button
              type="button"
              className="rounded-lg border border-border bg-[var(--bg-primary)] px-3 py-2 text-[13px] font-semibold text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] max-sm:w-full"
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="rounded-lg border border-accent bg-accent px-3 py-2 text-[13px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60 max-sm:w-full"
              disabled={form.state.values.goal.trim().length === 0}
            >
              Start Autopilot
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
