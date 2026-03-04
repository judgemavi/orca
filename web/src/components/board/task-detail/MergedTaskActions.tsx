import { useTaskDetailContext } from '../../../context/TaskDetailContext';
import { Button } from '../../Button';
import { TaskActionsLayout } from './TaskActionsLayout';
import { useTaskActions } from './useTaskActions';

interface Props {
  onClose: () => void;
}

export function MergedTaskActions({ onClose }: Props) {
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
        <Button variant="default" onClick={onClose} type="button">
          Close
        </Button>
      }
    />
  );
}
