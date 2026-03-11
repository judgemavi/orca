import { useTaskActions } from '../hooks/useTaskActions';
import { Button } from './Button';
import { TaskActionsLayout } from './TaskActionsLayout';

interface Props {
  onClose: () => void;
}

export function MergedTaskActions({ onClose }: Props) {
  const actions = useTaskActions();

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
