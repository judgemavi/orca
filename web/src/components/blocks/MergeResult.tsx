import type { TaskSummary } from '../../types'

interface Props {
  data: { merged: TaskSummary[]; failed: TaskSummary[] }
}

export function MergeResult({ data }: Props) {
  const merged = data?.merged ?? []
  const failed = data?.failed ?? []

  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-slate-700 bg-slate-900 p-4">
      <div className="text-sm font-semibold">
        Merge: {merged.length} merged, {failed.length} failed
      </div>
      {merged.length > 0 && (
        <div className="flex flex-col gap-1">
          {merged.map((t) => (
            <div
              key={t.task_id}
              className="flex items-center gap-2 text-[13px]"
            >
              <span className="font-bold text-emerald-500">&#10003;</span>
              <span>{t.title}</span>
            </div>
          ))}
        </div>
      )}
      {failed.length > 0 && (
        <div className="flex flex-col gap-1">
          {failed.map((t) => (
            <div
              key={t.task_id}
              className="flex items-center gap-2 text-[13px]"
            >
              <span className="font-bold text-rose-500">&#10007;</span>
              <span>{t.title}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
