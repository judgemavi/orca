import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Interaction, TaskReview } from '../../../types'
import { controlClass } from '../../../lib/constants'
import type { usePlanEditor } from './usePlanEditor'
import { Button } from '../../Button'

type PlanEditorState = ReturnType<typeof usePlanEditor>

type Props = {
  interaction: Interaction
  isEditableLatestPlan: boolean
  planEditor: PlanEditorState
  planReviews: TaskReview[]
}

function formatRelativeTime(iso: string): string {
  const timestamp = Date.parse(iso)
  if (!Number.isFinite(timestamp)) return 'just now'
  const deltaSeconds = Math.round((timestamp - Date.now()) / 1000)
  const absDeltaSeconds = Math.abs(deltaSeconds)
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  if (absDeltaSeconds < 60) return rtf.format(deltaSeconds, 'second')
  if (absDeltaSeconds < 3600)
    return rtf.format(Math.round(deltaSeconds / 60), 'minute')
  if (absDeltaSeconds < 86400)
    return rtf.format(Math.round(deltaSeconds / 3600), 'hour')
  return rtf.format(Math.round(deltaSeconds / 86400), 'day')
}

export function PlanPhaseSection({
  interaction,
  isEditableLatestPlan,
  planEditor,
  planReviews,
}: Props) {
  if (interaction.phase !== 'plan' || interaction.status !== 'completed') {
    return null
  }

  return (
    <>
      {isEditableLatestPlan && (
        <div className="rounded-lg bg-surface p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="flex items-center gap-1">
              <button
                type="button"
                className={[
                  'rounded border px-2 py-1 text-xs',
                  planEditor.planEditing
                    ? 'border-accent bg-accent/10 text-accent'
                    : 'border-border-subtle',
                ].join(' ')}
                onClick={() => planEditor.setPlanEditing(true)}
              >
                Edit
              </button>
              <button
                type="button"
                className={[
                  'rounded border px-2 py-1 text-xs',
                  !planEditor.planEditing
                    ? 'border-accent bg-accent/10 text-accent'
                    : 'border-border-subtle',
                ].join(' ')}
                onClick={() => planEditor.setPlanEditing(false)}
              >
                Preview
              </button>
            </div>
            <Button
              variant="primary"
              onClick={() => void planEditor.onSavePlan()}
              disabled={
                planEditor.planSaving ||
                planEditor.planDraft === planEditor.currentPlanText
              }
            >
              {planEditor.planSaving ? 'Saving…' : 'Save Plan'}
            </Button>
          </div>
          {planEditor.planEditing ? (
            <textarea
              value={planEditor.planDraft}
              onChange={(event) => planEditor.setPlanDraft(event.target.value)}
              className={`${controlClass} min-h-[220px] w-full resize-y font-mono text-xs leading-5`}
            />
          ) : (
            <div className="prose prose-invert prose-sm max-h-[300px] max-w-none overflow-auto rounded-lg bg-surface-alt p-4 text-xs">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {planEditor.planDraft}
              </ReactMarkdown>
            </div>
          )}
          {planEditor.planSaveError && (
            <div className="text-xs">{planEditor.planSaveError}</div>
          )}
        </div>
      )}

      {!isEditableLatestPlan && interaction.diff && (
        <div className="prose prose-invert prose-sm max-h-[300px] max-w-none overflow-auto rounded-lg bg-surface p-4 text-xs">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {interaction.diff}
          </ReactMarkdown>
        </div>
      )}

      {planReviews.length > 0 && (
        <div className="flex flex-col gap-2">
          {planReviews.map((review) => (
            <div
              key={review.id}
              className={[
                'rounded-md border p-4',
                review.status === 'pending'
                  ? 'border-amber-500/40 bg-amber-500/10'
                  : 'border-emerald-500/35 bg-emerald-500/10 opacity-80',
              ].join(' ')}
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-xs font-medium uppercase tracking-wide">
                  {review.status}
                </span>
                <span className="text-xs">
                  {formatRelativeTime(review.created_at)}
                </span>
              </div>
              <div className="whitespace-pre-wrap text-xs">
                {review.feedback}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
