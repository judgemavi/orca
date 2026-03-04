import type { ProposedTask } from '../../types'

interface BreakdownCardProps {
  proposed: ProposedTask[]
  accepted?: boolean
  rejected?: boolean
}

function toneClasses({ accepted, rejected }: BreakdownCardProps): string {
  if (accepted) return 'bg-emerald-500/10 shadow-sm shadow-emerald-500/10'
  if (rejected) return 'bg-surface-alt/70'
  return 'bg-orange-500/10 shadow-sm shadow-orange-500/10'
}

function statusLabel({ accepted, rejected, proposed }: BreakdownCardProps): string {
  if (accepted) return 'Breakdown accepted'
  if (rejected) return 'Breakdown rejected'
  return `Breakdown proposed ${proposed.length} subtasks`
}

export function BreakdownCard({ proposed, accepted, rejected }: BreakdownCardProps) {
  return (
    <div className={['rounded-lg p-3', toneClasses({ proposed, accepted, rejected })].join(' ')}>
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.05em]">
        {statusLabel({ proposed, accepted, rejected })}
      </div>
      {proposed.length === 0 ? (
        <div className="text-xs text-muted">No subtasks proposed.</div>
      ) : (
        <div className="flex flex-col gap-2">
          {proposed.map((task, index) => (
            <div
              key={`${task.title}-${index}`}
              className="rounded border border-border-subtle bg-surface-alt/60 p-2 text-xs"
            >
              <div className="font-medium">
                {index + 1}. {task.title || `Subtask ${index + 1}`}
              </div>
              {task.description ? (
                <div className="mt-1 whitespace-pre-wrap text-muted">{task.description}</div>
              ) : null}
              <div className="mt-1 text-[11px] text-muted">
                Depends On:{' '}
                {task.dependsOnIndices.length > 0
                  ? task.dependsOnIndices.map((dep) => dep + 1).join(', ')
                  : 'None'}
              </div>
              {task.suggestedTool ? (
                <div className="text-[11px] text-muted">Suggested Tool: {task.suggestedTool}</div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
