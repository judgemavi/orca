import { useTaskDetailContext } from '../../../context/TaskDetailContext'
import { Button } from '../../Button'
import { ApprovedTaskActions } from './ApprovedTaskActions'
import { FailedTaskActions } from './FailedTaskActions'
import { PendingTaskActions } from './PendingTaskActions'
import { ReviewTaskActions } from './ReviewTaskActions'
import { RunningTaskActions } from './RunningTaskActions'
import { TaskActionsLayout } from './TaskActionsLayout'

interface Props {
  onClose: () => void
}

export function TaskActionsBar({ onClose }: Props) {
  const { task } = useTaskDetailContext()

  if (task.status === 'pending' || task.status === 'planned') {
    return <PendingTaskActions />
  }

  if (task.status === 'running') {
    return <RunningTaskActions />
  }

  if (task.status === 'review') {
    return <ReviewTaskActions />
  }

  if (task.status === 'approved') {
    return <ApprovedTaskActions />
  }

  if (task.status === 'failed' || task.status === 'stopped') {
    return <FailedTaskActions />
  }

  if (task.status === 'merged') {
    return (
      <TaskActionsLayout
        tools={[]}
        actionTool=""
        actionModel=""
        actionModels={[]}
        actionModelsFetching={false}
        onToolChange={() => {}}
        onModelChange={() => {}}
        actions={
          <Button variant="default" onClick={onClose} type="button">
            Close
          </Button>
        }
      />
    )
  }

  if (task.status === 'decomposed') {
    return (
      <TaskActionsLayout
        tools={[]}
        actionTool=""
        actionModel=""
        actionModels={[]}
        actionModelsFetching={false}
        onToolChange={() => {}}
        onModelChange={() => {}}
        actions={
          <Button variant="default" onClick={onClose} type="button">
            Close
          </Button>
        }
      />
    )
  }

  return null
}
