import { ActionButton } from '../common/ActionButton'

interface Props {
  data: { message: string; task_id: string; actions: string[] }
  onAction?: (action: string) => void
}

export function EscalationBlock({ data, onAction }: Props) {
  const actions = data?.actions ?? []

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-amber-500 bg-amber-50 p-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
        <span className="text-lg text-amber-500">&#9888;</span>
        <span>{data?.message}</span>
      </div>
      {data?.task_id && (
        <div className="text-xs text-slate-500">
          Task: <span className="font-mono">{data.task_id.slice(0, 8)}</span>
        </div>
      )}
      {actions.length > 0 && (
        <div className="flex justify-end gap-2">
          {actions.map((a) => (
            <ActionButton
              key={a}
              label={a}
              variant={a.toLowerCase() === 'abort' ? 'danger' : 'default'}
              onClick={() => onAction?.(a)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
