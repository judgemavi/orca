import type { ProjectStatus } from '../../types'
import { StatusBadge, StatusIcon } from '../common/StatusBadge'
import { ActionButton } from '../common/ActionButton'

interface Props {
  data: ProjectStatus
  onAction?: (action: string) => void
}

const STATUS_ORDER = [
  'pending',
  'in_sprint',
  'running',
  'approved',
  'merged',
  'failed',
] as const

export function StatusCard({ data, onAction }: Props) {
  const taskCounts = data?.task_counts ?? {}
  const activeSprint = data?.active_sprint as {
    id?: string
    status?: string
  } | null

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-slate-700 bg-slate-900 p-4">
      <div className="text-base font-bold">
        {data?.project_name ?? 'Project'}
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2 text-[13px]">
          <span className="min-w-16 text-slate-400">Tasks:</span>
          <span className="flex gap-3">
            {STATUS_ORDER.map((s) => {
              const count = taskCounts[s]
              if (!count) return null
              return (
                <span
                  key={s}
                  className="inline-flex items-center gap-1 text-[13px]"
                >
                  <StatusIcon status={s} /> {count}
                </span>
              )
            })}
          </span>
        </div>
        <div className="flex items-center gap-2 text-[13px]">
          <span className="min-w-16 text-slate-400">Sprint:</span>
          <span>
            {activeSprint ? (
              <>
                <span className="font-mono text-[13px]">
                  {(activeSprint.id ?? '').slice(0, 8)}
                </span>{' '}
                <StatusBadge status={activeSprint.status ?? 'unknown'} />
              </>
            ) : (
              <span className="text-slate-400">none</span>
            )}
          </span>
        </div>
        <div className="flex items-center gap-2 text-[13px]">
          <span className="min-w-16 text-slate-400">Context:</span>
          <span>
            {data?.context_exists ? '\u2713 loaded' : '\u2717 not loaded'}
          </span>
        </div>
        <div className="flex items-center gap-2 text-[13px]">
          <span className="min-w-16 text-slate-400">Cost:</span>
          <span className="font-mono text-[13px]">
            ${(data?.total_cost ?? 0).toFixed(2)}
          </span>
        </div>
      </div>
      <div className="flex gap-2">
        <ActionButton
          label="Plan Sprint"
          variant="primary"
          onClick={() => onAction?.('plan sprint')}
        />
        <ActionButton label="View Tasks" onClick={() => onAction?.('tasks')} />
      </div>
    </div>
  )
}
