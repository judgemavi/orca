import { useTaskDetailContext } from '../context/TaskDetailContext';
import { useTaskActions } from '../hooks/useTaskActions';
import { Button } from './Button';
import { TaskActionsLayout } from './TaskActionsLayout';

export function RunningTaskActions() {
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
          variant="destructive"
          onClick={actions.handleStop}
          disabled={actions.stopPending}
        >
          {actions.stopPending ? (
            <>
              <span className="mr-1.5 inline-block h-3 w-3 animate-spin rounded-full border border-current border-t-transparent" />
              Stopping…
            </>
          ) : (
            'Stop'
          )}
        </Button>
      }
    />
  );
}
