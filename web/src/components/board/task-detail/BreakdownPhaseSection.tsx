import { Button } from '../../Button'
import type { Interaction, ProposedTask } from '../../../types'
import { INTERACTION_STATUSES, PHASES } from '@orca/types'
import {
  parseBreakdownPayload,
  parseJSONText,
} from '../../../lib/orchestratorRichContent'
import { BreakdownCard } from '../../shared/BreakdownCard'

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

  const showProposals =
    proposals &&
    proposals.proposed.length > 0 &&
    proposals.interactionId === interaction.id

  if (showProposals) {
    return (
      <div>
        <BreakdownCard proposed={proposals.proposed} />
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

  const result = parseBreakdownPayload(parseJSONText(interaction.qualityJson ?? ''))
  if (!result) return null

  return (
    <BreakdownCard
      proposed={result.proposed}
      accepted={result.accepted}
      rejected={result.rejected}
    />
  )
}
