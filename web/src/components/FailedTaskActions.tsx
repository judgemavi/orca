import { TASK_STATUSES } from '@orca/server/types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api';
import { useTaskDetailContext } from '../context/TaskDetailContext';
import { useStepExecution } from '../hooks/useStepExecution';
import { useTaskActions } from '../hooks/useTaskActions';
import { queryKeys } from '../lib/queryKeys';
import { getErrorMessage } from '../lib/utils';
import { Button } from './Button';
import { TaskActionsLayout, TaskFeedbackBox } from './TaskActionsLayout';

function PendingQuestionActions({ question }: { question: string }) {
  const { task } = useTaskDetailContext();
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (args: { taskId: string; answer: string }) =>
      api.provideInput(args.taskId, args.answer),
    onSuccess: () => {
      setAnswer('');
      setError(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.tasks });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.task(task.id),
      });
    },
    onError: (err: unknown) => {
      setError(getErrorMessage(err, 'Failed to submit answer'));
    },
  });

  return (
    <TaskActionsLayout
      tools={[]}
      actionTool=""
      actionModel=""
      actionModels={[]}
      actionModelsFetching={false}
      onToolChange={() => {}}
      onModelChange={() => {}}
      actionError={error}
      feedback={
        <div className="mb-3 flex flex-col gap-2 rounded-lg border border-accent/30 bg-accent/5 px-3 py-3">
          <div className="text-[13px] font-medium text-foreground">
            {question}
          </div>
          <textarea
            className="w-full resize-y rounded-md border border-border-subtle bg-surface px-2.5 py-2 text-[13px] outline-none focus:border-accent"
            rows={3}
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder="Type your answer…"
          />
        </div>
      }
      actions={
        <Button
          variant="primary"
          onClick={() =>
            mutation.mutate({ taskId: task.id, answer: answer.trim() })
          }
          disabled={!answer.trim() || mutation.isPending}
        >
          {mutation.isPending ? 'Submitting…' : 'Submit Answer'}
        </Button>
      }
    />
  );
}

function GatedStepActions() {
  const { task } = useTaskDetailContext();
  const actions = useTaskActions();
  const { error, runStepMutation } = useStepExecution({
    taskId: task.id,
    currentStep: task.currentStep,
    tool: actions.actionTool,
    model: actions.actionModel,
  });

  return (
    <TaskActionsLayout
      tools={actions.tools}
      actionTool={actions.actionTool}
      actionModel={actions.actionModel}
      actionModels={actions.actionModels}
      actionModelsFetching={actions.actionModelsFetching}
      onToolChange={actions.handleActionToolChange}
      onModelChange={actions.setActionModel}
      showToolModelSelector
      actionError={error ?? actions.actionError}
      feedback={
        <div className="mb-3 rounded-lg border border-accent/30 bg-accent/5 px-3 py-2.5 text-[13px]">
          <span className="font-medium">Gated step:</span>{' '}
          <span className="font-mono text-accent">{task.currentStep}</span>
        </div>
      }
      actions={
        <Button
          variant="primary"
          onClick={() => runStepMutation.mutate()}
          disabled={runStepMutation.isPending}
        >
          {runStepMutation.isPending ? 'Running…' : `Run ${task.currentStep}`}
        </Button>
      }
    />
  );
}

export function FailedTaskActions() {
  const { task } = useTaskDetailContext();
  const actions = useTaskActions();

  const isStopped = task.status === TASK_STATUSES.stopped;

  const pendingQuestionQuery = useQuery({
    queryKey: ['pending-question', task.id],
    queryFn: () => api.getPendingQuestion(task.id),
    enabled: isStopped,
  });

  if (pendingQuestionQuery.data?.question) {
    return (
      <PendingQuestionActions question={pendingQuestionQuery.data.question} />
    );
  }

  const hasGatedStep = isStopped && !!task.currentStep;

  if (hasGatedStep) {
    return <GatedStepActions />;
  }

  const showResume = isStopped;
  const busy =
    actions.runningBusy || (showResume ? actions.resumePending : false);

  return (
    <TaskActionsLayout
      tools={actions.tools}
      actionTool={actions.actionTool}
      actionModel={actions.actionModel}
      actionModels={actions.actionModels}
      actionModelsFetching={actions.actionModelsFetching}
      onToolChange={actions.handleActionToolChange}
      onModelChange={actions.setActionModel}
      showToolModelSelector={!isStopped}
      actionError={actions.actionError}
      feedback={
        showResume ? (
          <TaskFeedbackBox
            value={actions.resumeFeedback}
            onChange={actions.setResumeFeedback}
            placeholder="Resume feedback (optional)"
          />
        ) : null
      }
      actions={
        <Button
          variant="primary"
          onClick={showResume ? actions.handleResume : actions.handleStart}
          disabled={busy}
        >
          {showResume
            ? busy
              ? 'Resuming…'
              : 'Resume'
            : actions.runningBusy
              ? 'Re-running…'
              : 'Re-run'}
        </Button>
      }
    />
  );
}
