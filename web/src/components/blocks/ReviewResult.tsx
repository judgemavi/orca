import type { ReviewResultDisplay } from '../../types'
import { ActionButton } from '../common/ActionButton'

interface Props {
  data: { reviews: ReviewResultDisplay[]; actions: string[] }
  onAction?: (action: string) => void
}

export function ReviewResult({ data, onAction }: Props) {
  const reviews = data?.reviews ?? []
  const actions = data?.actions ?? []
  const approved = reviews.filter((r) => r.approved).length
  const rejected = reviews.filter((r) => !r.approved).length

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-slate-700 bg-slate-900 p-4">
      <div className="text-sm font-semibold">
        Review: {approved} approved, {rejected} rejected
      </div>
      <div className="flex flex-col gap-2.5">
        {reviews.map((r) => (
          <div key={r.task_id} className="flex flex-col gap-1">
            <span
              className={`text-[13px] font-semibold ${r.approved ? 'text-emerald-500' : 'text-rose-500'}`}
            >
              {r.approved ? '\u2713 Approved' : '\u2717 Rejected'}
            </span>
            <span className="text-[13px] font-medium">{r.title}</span>
            {r.feedback && (
              <div className="border-l-2 border-rose-500 pl-2 text-xs italic text-slate-400">
                "{r.feedback}"
              </div>
            )}
          </div>
        ))}
      </div>
      {actions.length > 0 && (
        <div className="flex justify-end gap-2">
          {actions.map((a) => (
            <ActionButton
              key={a}
              label={a}
              variant={
                a.toLowerCase().includes('integrate') ? 'primary' : 'default'
              }
              onClick={() => onAction?.(a)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
