import type { Task } from '../../types'
import { ActionButton } from '../common/ActionButton'
import { StatusBadge } from '../common/StatusBadge'

interface Props {
  reviewTasks: Task[]
  approvedTasks: Task[]
  onSelectTask: (taskId: string) => void
  onClose: () => void
  onMerge: () => void
  merging: boolean
}

export function ReviewPanel({
  reviewTasks,
  approvedTasks,
  onSelectTask,
  onClose,
  onMerge,
  merging,
}: Props) {
  return (
    <div className="flex w-120 shrink-0 flex-col overflow-hidden border-l border-slate-700">
      <div className="flex shrink-0 items-center justify-between border-b border-slate-700 px-4 py-3">
        <div className="flex items-center gap-2.5">
          <h2 className="text-sm font-semibold">Task Review</h2>
          <span className="text-xs">
            {reviewTasks.length} in review/failure
          </span>
        </div>
        <button
          className="rounded px-1.5 py-1 text-sm "
          onClick={onClose}
          type="button"
        >
          ✕
        </button>
      </div>

      <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
        {reviewTasks.length === 0 && (
          <div className="py-6 text-center text-[13px]">No tasks in review</div>
        )}
        {reviewTasks.map((task) => (
          <button
            key={task.id}
            className="flex flex-col gap-1 rounded border border-slate-700 px-3 py-2 text-left hover:bg-slate-900"
            onClick={() => onSelectTask(task.id)}
            type="button"
          >
            <div className="flex items-center gap-2">
              <StatusBadge status={task.status} />
              <span className="text-[13px] font-medium">{task.title}</span>
            </div>
            <span className="font-mono text-[10px]">{task.id.slice(0, 8)}</span>
          </button>
        ))}
      </div>

      <div className="flex shrink-0 items-center justify-between border-t border-slate-700 px-4 py-3">
        <span className="text-xs">
          {approvedTasks.length} approved task
          {approvedTasks.length !== 1 ? 's' : ''} ready to merge
        </span>
        <ActionButton
          variant="primary"
          onClick={onMerge}
          disabled={merging || approvedTasks.length === 0}
        >
          {merging ? 'Merging...' : 'Merge All'}
        </ActionButton>
      </div>
    </div>
  )
}
