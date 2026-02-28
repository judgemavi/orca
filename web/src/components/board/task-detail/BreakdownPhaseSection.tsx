import { Button } from '../../Button'
import type { Interaction, ProposedTask } from '../../../types'
import { INTERACTION_STATUSES, PHASES } from '../../../lib/phases'

type ParsedBreakdown = {
  accepted: boolean
  rejected: boolean
  proposed: ProposedTask[]
}

function parseBreakdownResult(qualityJSON: string | undefined): ParsedBreakdown {
  if (!qualityJSON) {
    return { accepted: false, rejected: false, proposed: [] }
  }
  try {
    const parsed = JSON.parse(qualityJSON) as {
      accepted?: unknown
      rejected?: unknown
      proposed?: unknown[]
    }
    const proposed = Array.isArray(parsed.proposed)
      ? (parsed.proposed as ProposedTask[])
      : []
    return {
      accepted: parsed.accepted === true,
      rejected: parsed.rejected === true,
      proposed,
    }
  } catch {
    return { accepted: false, rejected: false, proposed: [] }
  }
}

type Props = {
  interaction: Interaction
  proposals?: { interactionId: string; proposed: ProposedTask[] } | null
  onAccept?: (interactionId: string) => void
  onReject?: (interactionId: string) => void
  accepting?: boolean
  rejecting?: boolean
}

export function BreakdownPhaseSection({
  interaction,
  proposals,
  onAccept,
  onReject,
  accepting = false,
  rejecting = false,
}: Props) {
  if (interaction.phase !== PHASES.breakdown) return null
  if (interaction.status === INTERACTION_STATUSES.running) {
    return <div className="text-xs text-muted">Generating task breakdown…</div>
  }
  if (interaction.status === INTERACTION_STATUSES.failed) {
    return (
      <div className="rounded-md border border-danger/40 bg-danger/10 p-2 text-xs text-danger">
        {interaction.error || 'Breakdown failed'}
      </div>
    )
  }

  const result = parseBreakdownResult(interaction.quality_json)

  const showProposals =
    proposals &&
    proposals.proposed.length > 0 &&
    proposals.interactionId === interaction.id

  if (showProposals) {
    return (
      <div className="rounded-lg bg-orange-500/10 p-3 shadow-sm shadow-orange-500/10">
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.05em]">
          Proposed Subtasks
        </div>
        <div className="flex flex-col gap-2">
          {proposals.proposed.map((task, index) => (
            <div
              key={`${proposals.interactionId}-${index}`}
              className="rounded border border-border-subtle bg-surface-alt/60 p-2 text-xs"
            >
              <div className="font-medium">
                {index + 1}. {task.title}
              </div>
              <div className="mt-1 whitespace-pre-wrap text-muted">
                {task.description}
              </div>
              <div className="mt-1 text-[11px] text-muted">
                Depends On:{' '}
                {task.depends_on_indices.length > 0
                  ? task.depends_on_indices.map((dep) => dep + 1).join(', ')
                  : 'None'}
              </div>
              {task.suggested_tool && (
                <div className="text-[11px] text-muted">
                  Suggested Tool: {task.suggested_tool}
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            variant="primary"
            onClick={() => onAccept?.(proposals.interactionId)}
            disabled={accepting || rejecting}
          >
            {accepting ? 'Accepting…' : 'Accept'}
          </Button>
          <Button
            variant="default"
            onClick={() => onReject?.(proposals.interactionId)}
            disabled={accepting || rejecting}
          >
            {rejecting ? 'Rejecting…' : 'Reject'}
          </Button>
        </div>
      </div>
    )
  }

  const statusLabel = result.accepted
    ? 'Breakdown accepted'
    : result.rejected
      ? 'Breakdown rejected'
      : `Breakdown proposed ${result.proposed.length} subtasks`

  return (
    <div
      className={[
        'rounded-lg p-3',
        result.accepted
          ? 'bg-emerald-500/10 shadow-sm shadow-emerald-500/10'
          : result.rejected
            ? 'bg-surface-alt/70'
            : 'bg-orange-500/10 shadow-sm shadow-orange-500/10',
      ].join(' ')}
    >
      <div className="mb-2 flex flex-wrap items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.05em]">
        <span>{statusLabel}</span>
      </div>
      {result.proposed.length > 0 && (
        <div className="flex flex-col gap-2">
          {result.proposed.map((task, index) => (
            <div
              key={`${interaction.id}-settled-${index}`}
              className="rounded border border-border-subtle bg-surface-alt/60 p-2 text-xs"
            >
              <div className="font-medium">
                {index + 1}. {task.title}
              </div>
              {task.description && (
                <div className="mt-1 whitespace-pre-wrap text-muted">
                  {task.description}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
