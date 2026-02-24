import type { Task } from '../../types'
import { StatusIcon } from '../common/StatusBadge'
import { ActionButton } from '../common/ActionButton'

interface Props {
  data: { tasks: Task[]; actions: string[] }
  onAction?: (action: string) => void
}

export function TaskList({ data, onAction }: Props) {
  const tasks = data?.tasks ?? []
  const actions = data?.actions ?? []

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-slate-700 bg-slate-900 p-4">
      {actions.length > 0 && (
        <div className="flex gap-2">
          {actions.map((a) => (
            <ActionButton
              key={a}
              label={a}
              variant={a.toLowerCase().includes('plan') ? 'primary' : 'default'}
              onClick={() => onAction?.(a)}
            />
          ))}
        </div>
      )}
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr>
            <th className="border-b border-slate-700 px-2 py-1.5 text-left text-[11px] uppercase text-slate-400" />
            <th className="border-b border-slate-700 px-2 py-1.5 text-left text-[11px] uppercase text-slate-400">
              ID
            </th>
            <th className="border-b border-slate-700 px-2 py-1.5 text-left text-[11px] uppercase text-slate-400">
              Title
            </th>
            <th className="border-b border-slate-700 px-2 py-1.5 text-left text-[11px] uppercase text-slate-400">
              Deps
            </th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => (
            <tr key={task.id}>
              <td className="border-b border-slate-700 px-2 py-2 align-middle">
                <StatusIcon status={task.status} />
              </td>
              <td className="border-b border-slate-700 px-2 py-2 align-middle font-mono text-xs text-slate-400">
                {task.id.slice(0, 8)}
              </td>
              <td className="border-b border-slate-700 px-2 py-2 align-middle">
                {task.title}
              </td>
              <td className="border-b border-slate-700 px-2 py-2 align-middle font-mono text-xs text-slate-400">
                {(task.depends_on ?? []).map((d) => d.slice(0, 8)).join(', ')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {tasks.length === 0 && (
        <div className="py-6 text-center text-[13px] text-slate-400">
          No tasks yet
        </div>
      )}
    </div>
  )
}
