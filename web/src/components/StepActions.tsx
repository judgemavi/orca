import { INTERACTION_STATUSES } from '@orca/server/types';
import { useMemo, useState } from 'react';
import { useTaskDetailContext } from '../context/TaskDetailContext';
import { useCurrentStepQuery } from '../hooks/queries';
import { useInteractionsQuery } from '../hooks/useInteractions';
import { useStepExecution } from '../hooks/useStepExecution';
import { useTaskActions } from '../hooks/useTaskActions';
import { Button } from './Button';
import { TaskActionsLayout, TaskFeedbackBox } from './TaskActionsLayout';

export function StepActions() {
  const { task, isOperationRunning } = useTaskDetailContext();
  const actions = useTaskActions();
  const [manualMode, setManualMode] = useState(false);
  const [manualOutput, setManualOutput] = useState('');
  // Branch that opened field inputs (null = not in field input mode)
  const [activeBranch, setActiveBranch] = useState<string | null>(null);
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const {
    error,
    setError,
    runStepMutation,
    manualStepMutation,
    completeStepMutation,
  } = useStepExecution({
    taskId: task.id,
    currentStep: task.currentStep,
    tool: actions.actionTool,
    model: actions.actionModel,
  });

  const { data: stepInfo } = useCurrentStepQuery(
    task.id,
    task.currentStep ?? undefined,
    !!task.currentStep,
  );

  const stepType = stepInfo?.step?.type;
  const branches = stepInfo?.step?.branches ?? [];
  const isContextStep = stepType === 'context';
  const isDecisionStep = stepType === 'decision';

  const activeBranchDef = activeBranch
    ? branches.find((b) => b.name === activeBranch)
    : null;

  const interactionsQuery = useInteractionsQuery(task.id);
  const hasOutput = useMemo(() => {
    if (!task.currentStep || !interactionsQuery.data) return false;
    const completed = interactionsQuery.data.filter(
      (ix) => ix.status === INTERACTION_STATUSES.completed,
    );
    if (completed.length === 0) return false;
    const forStep = completed
      .filter((ix) => ix.stepName === task.currentStep)
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
    if (forStep.length === 0) return false;
    const latest = [...completed].sort(
      (a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt),
    )[0];
    return latest?.stepName === task.currentStep;
  }, [task.currentStep, interactionsQuery.data]);

  const hasRunningInteraction = useMemo(() => {
    if (!task.currentStep || !interactionsQuery.data) return false;
    return interactionsQuery.data.some(
      (ix) =>
        ix.stepName === task.currentStep &&
        ix.status === INTERACTION_STATUSES.running,
    );
  }, [task.currentStep, interactionsQuery.data]);

  const stepBusy =
    isOperationRunning(task.currentStep ?? '', task.id) ||
    task.status === 'running' ||
    hasRunningInteraction;

  const handleBranchClick = (branch: { name: string; fields: string[] }) => {
    if (branch.fields.length > 0) {
      setActiveBranch(branch.name);
      setFieldValues({});
    } else {
      completeStepMutation.mutate({ outcome: branch.name });
    }
  };

  const allFieldsFilled =
    activeBranchDef?.fields.every((f) => fieldValues[f]?.trim()) ?? false;

  let actionButtons: React.ReactNode = null;
  let feedbackNode: React.ReactNode = null;

  if (manualMode) {
    feedbackNode = (
      <div className="space-y-2">
        <div className="rounded-lg border border-accent/30 bg-accent/5 px-3 py-2.5 text-[13px]">
          <span className="font-medium">Manual:</span>{' '}
          <span className="font-mono text-accent">{task.currentStep}</span>
        </div>
        <textarea
          className="w-full rounded-md border border-border-subtle bg-surface-alt px-3 py-2 font-mono text-sm"
          rows={10}
          placeholder={`Enter ${task.currentStep} output manually…`}
          value={manualOutput}
          onChange={(e) => setManualOutput(e.target.value)}
        />
      </div>
    );
    actionButtons = (
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
            setError(null);
          }}
          disabled={manualStepMutation.isPending}
        >
          Cancel
        </Button>
      </div>
    );
  } else if (activeBranch && activeBranchDef) {
    feedbackNode = (
      <div className="space-y-2">
        {activeBranchDef.fields.map((field) => (
          <TaskFeedbackBox
            key={field}
            value={fieldValues[field] ?? ''}
            onChange={(v) =>
              setFieldValues((prev) => ({ ...prev, [field]: v }))
            }
            placeholder={fieldLabel(field)}
          />
        ))}
      </div>
    );
    actionButtons = (
      <div className="flex gap-2">
        <Button
          variant="primary"
          onClick={() =>
            completeStepMutation.mutate(
              { outcome: activeBranch, data: fieldValues },
              {
                onSuccess: () => {
                  setActiveBranch(null);
                  setFieldValues({});
                },
              },
            )
          }
          disabled={completeStepMutation.isPending || !allFieldsFilled}
        >
          {completeStepMutation.isPending ? 'Submitting…' : 'Submit'}
        </Button>
        <Button
          variant="default"
          onClick={() => {
            setActiveBranch(null);
            setFieldValues({});
            setError(null);
          }}
          disabled={completeStepMutation.isPending}
        >
          Cancel
        </Button>
      </div>
    );
  } else if (stepBusy) {
    actionButtons = (
      <div className="flex gap-2">
        <Button variant="primary" disabled>
          Running…
        </Button>
        <Button
          variant="destructive"
          onClick={actions.handleStop}
          disabled={actions.stopPending}
        >
          {actions.stopPending ? 'Stopping…' : 'Stop'}
        </Button>
      </div>
    );
  } else if (hasOutput || isDecisionStep) {
    actionButtons = (
      <div className="flex gap-2">
        {branches.map((branch, i) => (
          <Button
            key={branch.name}
            variant={i === 0 ? 'primary' : 'default'}
            onClick={() => handleBranchClick(branch)}
            disabled={completeStepMutation.isPending}
          >
            {completeStepMutation.isPending
              ? 'Processing…'
              : branchLabel(branch.name)}
          </Button>
        ))}
        {!hasOutput && (
          <Button
            variant="default"
            onClick={() => runStepMutation.mutate()}
            disabled={runStepMutation.isPending}
          >
            {runStepMutation.isPending ? 'Running…' : `Run ${task.currentStep}`}
          </Button>
        )}
      </div>
    );
  } else {
    actionButtons = (
      <div className="flex gap-2">
        <Button
          variant="primary"
          onClick={() => runStepMutation.mutate()}
          disabled={runStepMutation.isPending}
        >
          {runStepMutation.isPending ? 'Running…' : `Run ${task.currentStep}`}
        </Button>
        {isContextStep && (
          <Button variant="default" onClick={() => setManualMode(true)}>
            Manual
          </Button>
        )}
      </div>
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
        !manualMode &&
        !activeBranch &&
        !stepBusy &&
        !hasOutput &&
        !isDecisionStep
      }
      actionError={error ?? actions.actionError}
      feedback={feedbackNode}
      actions={actionButtons}
    />
  );
}

function branchLabel(name: string): string {
  return name.replaceAll('_', ' ').replace(/^\w/, (c) => c.toUpperCase());
}

function fieldLabel(name: string): string {
  return `${name.replaceAll('_', ' ').replace(/^\w/, (c) => c.toUpperCase())}…`;
}
