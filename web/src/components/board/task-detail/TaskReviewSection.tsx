import { DiffViewer } from '../../blocks/DiffViewer'
import { ActionButton } from '../../common/ActionButton'
import type { ReviewArtifact, Task } from '../../../types'

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

function ReviewHistorySection({
  reviews,
}: {
  reviews: Array<{
    id: string
    status: string
    created_at: string
    feedback: string
  }>
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-xs font-semibold uppercase tracking-[0.06em] text-amber-300">
        Review History
      </div>
      <div className="flex flex-col gap-1.5">
        {reviews.map((review) => (
          <div
            key={review.id}
            className={[
              'rounded-md border p-2.5',
              review.status === 'pending'
                ? 'border-amber-500/40 bg-amber-500/10 opacity-100'
                : 'border-emerald-500/35 bg-emerald-500/10 opacity-70',
            ].join(' ')}
          >
            <div className="mb-1 flex items-center justify-between gap-2">
              <span
                className={[
                  'rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.05em]',
                  review.status === 'pending'
                    ? 'bg-amber-400/15 text-amber-200'
                    : 'bg-emerald-400/15 text-emerald-200',
                ].join(' ')}
              >
                {review.status}
              </span>
              <span className="text-[11px] text-amber-100/90">
                {formatRelativeTime(review.created_at)}
              </span>
            </div>
            <div className="whitespace-pre-wrap text-xs text-amber-100">
              {review.feedback}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

interface Props {
  task: Task
  artifact: ReviewArtifact | null
  showDiff: boolean
  feedback: string
  approving: boolean
  requesting: boolean
  reviewActionError: string | null
  reviews: Array<{
    id: string
    status: string
    created_at: string
    feedback: string
  }>
  onToggleDiff: () => void
  onFeedbackChange: (value: string) => void
  onApprove: () => void
  onRequestChanges: () => void
}

export function TaskReviewSection({
  task,
  artifact,
  showDiff,
  feedback,
  approving,
  requesting,
  reviewActionError,
  reviews,
  onToggleDiff,
  onFeedbackChange,
  onApprove,
  onRequestChanges,
}: Props) {
  return (
    <>
      {artifact && artifact.diff && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-[var(--text-secondary)]">Diff</span>
            <div className="flex flex-1 flex-wrap gap-1">
              {artifact.files?.map((file) => (
                <span
                  key={file}
                  className="rounded bg-[var(--bg-sidebar)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-secondary)]"
                >
                  {file.split('/').pop()}
                </span>
              ))}
            </div>
            <button
              className="whitespace-nowrap rounded border border-[var(--border)] px-2 py-0.5 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]"
              onClick={onToggleDiff}
              type="button"
            >
              {showDiff ? 'Hide' : 'Show diff'}
            </button>
          </div>
          {showDiff && (
            <DiffViewer
              data={{
                task_id: task.id,
                title: task.title,
                diff: artifact.diff,
                files_changed: artifact.files ?? [],
                actions: [],
              }}
            />
          )}
        </div>
      )}

      {['review', 'approved', 'merged'].includes(task.status) &&
        reviews.length > 0 && <ReviewHistorySection reviews={reviews} />}

      {task.status === 'review' && (
        <div className="flex flex-col gap-2.5 rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
          <div className="text-xs font-semibold uppercase tracking-[0.06em] text-amber-300">
            Review Actions
          </div>

          <div className="flex items-center justify-between gap-2">
            <div className="text-xs text-amber-100">
              Approve this task for integration.
            </div>
            <ActionButton
              variant="primary"
              onClick={onApprove}
              disabled={approving || requesting}
            >
              {approving ? 'Approving…' : 'Approve'}
            </ActionButton>
          </div>

          <div className="flex flex-col gap-1.5">
            <label
              className="text-xs font-medium text-amber-200"
              htmlFor="request-changes-feedback"
            >
              Request Changes
            </label>
            <textarea
              id="request-changes-feedback"
              className="w-full resize-y rounded-md border border-amber-500/40 bg-[var(--bg-primary)] p-2 text-[13px] text-[var(--text-primary)] outline-none focus:border-amber-400"
              rows={4}
              value={feedback}
              onChange={(e) => onFeedbackChange(e.target.value)}
              placeholder="Describe what needs to be changed..."
            />
            <div className="flex justify-end">
              <button
                type="button"
                className={[
                  'inline-flex items-center rounded-md border px-3 py-1 text-[13px] font-medium transition-all duration-150',
                  requesting
                    ? 'cursor-not-allowed border-amber-400/40 text-amber-300/60'
                    : 'border-amber-400 text-amber-200 hover:bg-amber-400/15',
                ].join(' ')}
                onClick={onRequestChanges}
                disabled={requesting || approving}
              >
                {requesting ? 'Submitting…' : 'Submit Request Changes'}
              </button>
            </div>
          </div>

          {reviewActionError && (
            <div className="text-xs text-[var(--status-failed)]">{reviewActionError}</div>
          )}
        </div>
      )}
    </>
  )
}
