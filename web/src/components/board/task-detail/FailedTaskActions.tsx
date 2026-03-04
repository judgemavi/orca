import { useTaskDetailContext } from '../../../context/TaskDetailContext'
import { TASK_STATUSES } from '@orca/types'
import { Button } from '../../Button'
import { TaskActionsLayout, TaskFeedbackBox } from './TaskActionsLayout'
import { useTaskActions } from './useTaskActions'

export function FailedTaskActions() {
  const { task } = useTaskDetailContext()
  const actions = useTaskActions(task)

  const isStopped = task.status === TASK_STATUSES.stopped
  const hasSession = Boolean(task.sessionId?.trim())
  const showResume = isStopped && hasSession
  const busy = actions.runningBusy || (showResume ? actions.resumePending : false)

  return (
    <TaskActionsLayout
      tools={actions.tools}
      actionTool={actions.actionTool}
      actionModel={actions.actionModel}
      actionModels={actions.actionModels}
      actionModelsFetching={actions.actionModelsFetching}
      onToolChange={actions.handleActionToolChange}
      onModelChange={actions.setActionModel}
      showToolModelSelector={!isStopped}
      actionError={actions.actionError}
      feedback={
        showResume ? (
          <TaskFeedbackBox
            value={actions.resumeFeedback}
            onChange={actions.setResumeFeedback}
            placeholder={`Resume feedback for session ${task.sessionId} (optional)`}
          />
        ) : null
      }
      actions={
        <Button
          variant="primary"
          onClick={showResume ? actions.handleResume : actions.handleStart}
          disabled={busy || (isStopped && !showResume)}
        >
          {showResume
            ? busy
              ? 'Resuming…'
              : 'Resume'
            : isStopped
              ? 'Resume unavailable'
              : actions.runningBusy
                ? 'Re-running…'
                : 'Re-run'}
        </Button>
      }
    />
  )
}
