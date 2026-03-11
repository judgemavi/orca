import { TASK_STATUSES } from '@orca/server/types';
import { useState } from 'react';
import { useTaskDetailContext } from '../context/TaskDetailContext';
import { useCurrentStepQuery } from '../hooks/queries';
import { useStepExecution } from '../hooks/useStepExecution';
import { useTaskActions } from '../hooks/useTaskActions';
import { Button } from './Button';
import { TaskActionsLayout } from './TaskActionsLayout';

export function PendingTaskActions() {
  const { task, isOperationRunning } = useTaskDetailContext();
  const actions = useTaskActions();
  const [manualMode, setManualMode] = useState(false);
  const [manualOutput, setManualOutput] = useState('');
  const {
    error: stepError,
    setError: setStepError,
    runStepMutation,
    manualStepMutation,
  } = useStepExecution({
    taskId: task.id,
    currentStep: task.currentStep,
    tool: actions.actionTool,
    model: actions.actionModel,
  });

  const showStart = task.status === TASK_STATUSES.planned;
  const hasCurrentStep =
    task.status === TASK_STATUSES.pending && !!task.currentStep;
  const stepBusy =
    hasCurrentStep &&
    (isOperationRunning(task.currentStep ?? '', task.id) ||
      task.status === TASK_STATUSES.running);

  const { data: stepInfo } = useCurrentStepQuery(
    task.id,
    task.currentStep ?? undefined,
    hasCurrentStep,
  );
  const isContextStep = stepInfo?.step?.type === 'context';

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
  } else if (hasCurrentStep) {
    actionButtons = manualMode ? (
      <div className="flex gap-2">
        <Button
          variant="primary"
          onClick={() =>
            manualStepMutation.mutate(manualOutput, {
              onSuccess: () => {
                setManualMode(false);
                setManualOutput('');
              },
            })
          }
          disabled={manualStepMutation.isPending || !manualOutput.trim()}
        >
          {manualStepMutation.isPending ? 'Saving…' : 'Save'}
        </Button>
        <Button
          variant="default"
          onClick={() => {
            setManualMode(false);
            setStepError(null);
          }}
          disabled={manualStepMutation.isPending}
        >
          Cancel
        </Button>
      </div>
    ) : (
      <div className="flex gap-2">
        <Button
          variant="primary"
          onClick={() => runStepMutation.mutate()}
          disabled={runStepMutation.isPending || stepBusy}
        >
          {runStepMutation.isPending || stepBusy
            ? 'Running…'
            : `Run ${task.currentStep}`}
        </Button>
        {isContextStep && (
          <Button
            variant="default"
            onClick={() => setManualMode(true)}
            disabled={stepBusy}
          >
            Manual
          </Button>
        )}
      </div>
    );
  } else {
    actionButtons = (
      <>
        {!actions.hideEvaluateAction && (
          <span title={actions.evaluateDisabledReason}>
            <Button
              variant="default"
              onClick={actions.handleEvaluateTask}
              disabled={
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
              disabled={actions.operationInProgress || actions.breakingDown}
            >
              {actions.breakingDown ? 'Breaking down…' : 'Breakdown'}
            </Button>
          )}
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
      showToolModelSelector={
        !actions.operationInProgress &&
        (showStart ||
          (hasCurrentStep && !manualMode && !stepBusy) ||
          task.status === TASK_STATUSES.pending)
      }
      actionError={stepError ?? actions.actionError}
      feedback={
        hasCurrentStep ? (
          <div className="space-y-2">
            <div className="rounded-lg border border-accent/30 bg-accent/5 px-3 py-2.5 text-[13px]">
              <span className="font-medium">Next step:</span>{' '}
              <span className="font-mono text-accent">{task.currentStep}</span>
            </div>
            {manualMode && (
              <textarea
                className="w-full rounded-md border border-border-subtle bg-surface-alt px-3 py-2 font-mono text-sm"
                rows={10}
                placeholder={`Enter ${task.currentStep} output manually…`}
                value={manualOutput}
                onChange={(e) => setManualOutput(e.target.value)}
                // biome-ignore lint/a11y/noAutofocus: manual editor needs focus
                autoFocus
              />
            )}
          </div>
        ) : null
      }
      actions={actionButtons}
    />
  );
}
