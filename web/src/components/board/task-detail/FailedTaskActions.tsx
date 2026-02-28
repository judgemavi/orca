import { useTaskDetailContext } from '../../../context/TaskDetailContext'
import { Button } from '../../Button'
import { TaskActionsLayout } from './TaskActionsLayout'
import { useTaskActions } from './useTaskActions'

export function FailedTaskActions() {
  const { task } = useTaskDetailContext()
  const actions = useTaskActions(task)

  const isStopped = task.status === 'stopped'

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
      actions={
        <Button
          variant="primary"
          onClick={isStopped ? actions.handleResume : actions.handleStart}
          disabled={
            actions.runningBusy || (isStopped ? actions.resumePending : false)
          }
        >
          {isStopped
            ? actions.runningBusy || actions.resumePending
              ? 'Resuming…'
              : 'Resume'
            : actions.runningBusy
              ? 'Re-running…'
              : 'Re-run'}
        </Button>
      }
    />
  )
}
