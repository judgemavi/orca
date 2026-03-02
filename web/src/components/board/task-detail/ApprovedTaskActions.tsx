import { useTaskDetailContext } from '../../../context/TaskDetailContext'
import { Button } from '../../Button'
import { TaskActionsLayout } from './TaskActionsLayout'
import { useTaskActions } from './useTaskActions'

export function ApprovedTaskActions() {
  const { task } = useTaskDetailContext()
  const actions = useTaskActions(task)

  return (
    <TaskActionsLayout
      tools={actions.tools}
      actionTool={actions.actionTool}
      actionModel={actions.actionModel}
      actionModels={actions.actionModels}
      actionModelsFetching={actions.actionModelsFetching}
      onToolChange={actions.handleActionToolChange}
      onModelChange={actions.setActionModel}
      actionError={actions.actionError}
      actions={
        <>
          <Button
            variant="default"
            onClick={actions.handleRetro}
            disabled={actions.phaseInProgress}
          >
            {actions.retroInProgress ? 'Running Retro…' : 'Run Retro'}
          </Button>
          <Button
            variant="primary"
            onClick={actions.handleMerge}
            disabled={actions.phaseInProgress}
          >
            {actions.mergeInProgress ? 'Merging…' : 'Merge'}
          </Button>
        </>
      }
    />
  )
}
