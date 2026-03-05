import { TASK_STATUSES } from '@orca/types';
import { useTaskDetailContext } from '../../../context/TaskDetailContext';
import { Button } from '../../Button';
import { TaskActionsLayout, TaskFeedbackBox } from './TaskActionsLayout';
import { useTaskActions } from './useTaskActions';

export function PendingTaskActions() {
  const { task } = useTaskDetailContext();
  const actions = useTaskActions(task);

  const showStart = task.status === TASK_STATUSES.planned;
  const showFeedback =
    task.status === TASK_STATUSES.pending && actions.requestPlanChangesExpanded;
  const showSelector =
    showStart ||
    (task.status === TASK_STATUSES.pending &&
      (!actions.hasPlan || showFeedback));

  let actionButtons = null;
  if (showStart) {
    actionButtons = (
      <Button
        variant="primary"
        onClick={actions.handleStart}
        disabled={actions.runningBusy}
      >
        {actions.runningBusy ? 'Starting…' : 'Start'}
      </Button>
    );
  } else if (!actions.hasPlan) {
    actionButtons = (
      <>
        <Button
          variant="primary"
          onClick={actions.handleGeneratePlan}
          disabled={
            actions.planLoading || actions.operationInProgress || actions.evaluating
          }
        >
          {actions.planGenerating || actions.generatePlanPending
            ? 'Generating…'
            : 'Generate Plan'}
        </Button>
        {!actions.hideEvaluateAction && (
          <span title={actions.evaluateDisabledReason}>
            <Button
              variant="default"
              onClick={actions.handleEvaluateTask}
              disabled={
                actions.planLoading ||
                actions.operationInProgress ||
                actions.evaluating ||
                actions.descriptionUnchangedSinceLastEvaluation
              }
            >
              {actions.evaluatePending || actions.evaluating
                ? 'Evaluating…'
                : 'Evaluate'}
            </Button>
          </span>
        )}
        {actions.latestBreakdownProposals == null &&
          !actions.hideBreakdownAction && (
            <Button
              variant="default"
              onClick={actions.handleBreakdownTask}
              disabled={
                actions.planLoading ||
                actions.operationInProgress ||
                actions.breakingDown
              }
            >
              {actions.breakingDown ? 'Breaking down…' : 'Breakdown'}
            </Button>
          )}
      </>
    );
  } else if (actions.requestPlanChangesExpanded) {
    actionButtons = (
      <>
        <Button
          variant="default"
          onClick={() => {
            actions.setRequestPlanChangesExpanded(false);
            actions.setRequestPlanFeedback('');
            actions.setActionError(null);
          }}
          disabled={
            actions.operationInProgress || actions.requestPlanChangesPending
          }
        >
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={actions.handleRequestPlanChanges}
          disabled={
            actions.operationInProgress ||
            actions.requestPlanChangesPending ||
            actions.approvePlanPending
          }
        >
          {actions.requestPlanChangesPending
            ? 'Submitting…'
            : 'Submit Plan Changes'}
        </Button>
      </>
    );
  } else {
    actionButtons = (
      <>
        <Button
          variant="primary"
          onClick={actions.handleApprovePlan}
          disabled={
            actions.operationInProgress ||
            actions.approvePlanPending ||
            actions.requestPlanChangesPending
          }
        >
          {actions.approvePlanPending ? 'Approving…' : 'Approve Plan'}
        </Button>
        <Button
          variant="default"
          onClick={() => {
            actions.setRequestPlanChangesExpanded(true);
            actions.setAIReviewExpanded(false);
            actions.setAIFeedbackAppliedNotice(false);
            actions.setActionError(null);
          }}
          disabled={
            actions.operationInProgress ||
            actions.approvePlanPending ||
            actions.requestPlanChangesPending
          }
        >
          Request Plan Changes
        </Button>
      </>
    );
  }

  return (
    <TaskActionsLayout
      tools={actions.tools}
      actionTool={actions.actionTool}
      actionModel={actions.actionModel}
      actionModels={actions.actionModels}
      actionModelsFetching={actions.actionModelsFetching}
      onToolChange={actions.handleActionToolChange}
      onModelChange={actions.setActionModel}
      showToolModelSelector={showSelector}
      actionError={actions.actionError}
      feedback={
        showFeedback ? (
          <TaskFeedbackBox
            value={actions.requestPlanFeedback}
            onChange={actions.setRequestPlanFeedback}
          />
        ) : null
      }
      actions={actionButtons}
    />
  );
}
