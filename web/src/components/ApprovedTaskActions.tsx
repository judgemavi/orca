import { useTaskDetailContext } from '../context/TaskDetailContext';
import { useTaskActions } from '../hooks/useTaskActions';
import { Button } from './Button';
import { TaskActionsLayout } from './TaskActionsLayout';

export function ApprovedTaskActions() {
  const { task } = useTaskDetailContext();
  const actions = useTaskActions(task);

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
        <Button
          variant="primary"
          onClick={actions.handleMerge}
          disabled={actions.operationInProgress}
        >
          {actions.mergeInProgress ? 'Merging…' : 'Merge'}
        </Button>
      }
    />
  );
}
