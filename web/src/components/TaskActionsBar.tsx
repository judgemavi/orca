import { TASK_STATUSES } from '@orca/server/types';
import { useTaskDetailContext } from '../context/TaskDetailContext';
import { Button } from './Button';
import { FailedTaskActions } from './FailedTaskActions';
import { MergedTaskActions } from './MergedTaskActions';
import { PendingTaskActions } from './PendingTaskActions';
import { StepActions } from './StepActions';
import { TaskActionsLayout } from './TaskActionsLayout';

interface Props {
  onClose: () => void;
}

export function TaskActionsBar({ onClose }: Props) {
  const { task } = useTaskDetailContext();

  // Terminal states
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

  // Failed/stopped — special handling for resume, pending questions
  if (
    task.status === TASK_STATUSES.failed ||
    task.status === TASK_STATUSES.stopped
  ) {
    return <FailedTaskActions />;
  }

  // Has a workflow step → dynamic step actions
  if (task.currentStep) {
    return <StepActions />;
  }

  // Pre-workflow (no currentStep) → evaluate/breakdown
  return <PendingTaskActions />;
}
