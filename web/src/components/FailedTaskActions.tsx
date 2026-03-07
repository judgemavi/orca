import { TASK_STATUSES } from '@orca/server/types';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api';
import { useTaskDetailContext } from '../context/TaskDetailContext';
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

export function FailedTaskActions() {
  const { task } = useTaskDetailContext();
  const actions = useTaskActions(task);

  if (task.pendingQuestion) {
    return <PendingQuestionActions question={task.pendingQuestion} />;
  }

  const isStopped = task.status === TASK_STATUSES.stopped;
  const hasSession = Boolean(task.sessionId?.trim());
  const showResume = isStopped && hasSession;
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
            placeholder={`Resume feedback for session ${task.sessionId} (optional)`}
          />
        ) : null
      }
      actions={
        <Button
          variant="primary"
          onClick={showResume ? actions.handleResume : actions.handleStart}
          disabled={busy || (isStopped && !showResume)}
        >
          {showResume
            ? busy
              ? 'Resuming…'
              : 'Resume'
            : isStopped
              ? 'Resume unavailable'
              : actions.runningBusy
                ? 'Re-running…'
                : 'Re-run'}
        </Button>
      }
    />
  );
}
