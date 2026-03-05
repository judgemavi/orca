import { TASK_STATUSES } from '@orca/server/types';
import { useTaskDetailContext } from '../../../context/TaskDetailContext';
import { Button } from '../../Button';
import { ApprovedTaskActions } from './ApprovedTaskActions';
import { FailedTaskActions } from './FailedTaskActions';
import { MergedTaskActions } from './MergedTaskActions';
import { PendingTaskActions } from './PendingTaskActions';
import { ReviewTaskActions } from './ReviewTaskActions';
import { RunningTaskActions } from './RunningTaskActions';
import { TaskActionsLayout } from './TaskActionsLayout';

interface Props {
  onClose: () => void;
}

export function TaskActionsBar({ onClose }: Props) {
  const { task } = useTaskDetailContext();

  if (
    task.status === TASK_STATUSES.pending ||
    task.status === TASK_STATUSES.planned
  ) {
    return <PendingTaskActions />;
  }

  if (task.status === TASK_STATUSES.running) {
    return <RunningTaskActions />;
  }

  if (task.status === TASK_STATUSES.review) {
    return <ReviewTaskActions />;
  }

  if (task.status === TASK_STATUSES.approved) {
    return <ApprovedTaskActions />;
  }

  if (
    task.status === TASK_STATUSES.failed ||
    task.status === TASK_STATUSES.stopped
  ) {
    return <FailedTaskActions />;
  }

  if (task.status === TASK_STATUSES.merged) {
    return <MergedTaskActions onClose={onClose} />;
  }

  if (task.status === TASK_STATUSES.broken_down) {
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
    );
  }

  return null;
}
