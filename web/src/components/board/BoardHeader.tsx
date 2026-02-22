import type { Sprint } from '../../types'
import { ActionButton } from '../common/ActionButton'
import { StatusBadge } from '../common/StatusBadge'

interface Props {
  sprint: Sprint | null
  actionLoading: boolean
  sprintStarting: boolean
  reviewRunning: boolean
  integrating: boolean
  decomposeRunning: boolean
  cleanupRunning: boolean
  exploring: boolean
  onPlanSprint: () => void
  onStartSprint: (sprintId: string) => void
  onCancelSprint: (sprintId: string) => void
  onToggleReview: () => void
  onIntegrate: () => void
  onResetSprint: (sprintId: string) => void
}

export function BoardHeader({
  sprint,
  actionLoading,
  sprintStarting,
  reviewRunning,
  integrating,
  decomposeRunning,
  cleanupRunning,
  exploring,
  onPlanSprint,
  onStartSprint,
  onCancelSprint,
  onToggleReview,
  onIntegrate,
  onResetSprint,
}: Props) {
  const sprintTaskCount = sprint ? (sprint.task_ids ?? []).length : 0

  return (
    <div className="flex shrink-0 items-center justify-between border-b border-border bg-[var(--bg-secondary)] px-4 py-2.5">
      <div className="flex items-center gap-2 text-sm">
        <span className="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
          Sprint
        </span>
        {sprint ? (
          <>
            <span className="font-mono text-xs text-[var(--text-primary)]">
              {sprint.id.slice(0, 8)}
            </span>
            <StatusBadge status={sprint.status} />
            <span className="text-xs text-[var(--text-secondary)]">
              {sprintTaskCount} task{sprintTaskCount !== 1 ? 's' : ''}
            </span>
          </>
        ) : (
          <span className="text-xs italic text-[var(--text-secondary)]">none</span>
        )}
        {(decomposeRunning || cleanupRunning || exploring) && (
          <span className="text-xs text-accent">
            {decomposeRunning && 'Decomposing... '}
            {cleanupRunning && 'Cleaning... '}
            {exploring && 'Exploring...'}
          </span>
        )}
      </div>

      <div className="flex items-center gap-2">
        {!sprint && (
          <ActionButton
            variant="primary"
            onClick={onPlanSprint}
            disabled={actionLoading}
          >
            Plan Sprint
          </ActionButton>
        )}

        {sprint?.status === 'planning' && (
          <>
            <ActionButton
              variant="primary"
              onClick={() => onStartSprint(sprint.id)}
              disabled={actionLoading || sprintStarting}
            >
              {sprintStarting ? 'Starting...' : 'Start'}
            </ActionButton>
            <ActionButton
              variant="danger"
              onClick={() => onCancelSprint(sprint.id)}
              disabled={actionLoading}
            >
              Cancel
            </ActionButton>
          </>
        )}

        {sprint?.status === 'running' && (
          <ActionButton
            variant="danger"
            onClick={() => onCancelSprint(sprint.id)}
            disabled={actionLoading}
          >
            Cancel
          </ActionButton>
        )}

        {(sprint?.status === 'completed' || sprint?.status === 'failed') && (
          <>
            <ActionButton
              variant="default"
              onClick={onToggleReview}
              disabled={reviewRunning}
            >
              {reviewRunning ? 'Reviewing...' : 'Review'}
            </ActionButton>
            <ActionButton
              variant="primary"
              onClick={onIntegrate}
              disabled={actionLoading || integrating}
            >
              {integrating ? 'Integrating...' : 'Integrate'}
            </ActionButton>
            <ActionButton
              variant="default"
              onClick={() => onResetSprint(sprint.id)}
              disabled={actionLoading}
            >
              Reset
            </ActionButton>
          </>
        )}
      </div>
    </div>
  )
}
