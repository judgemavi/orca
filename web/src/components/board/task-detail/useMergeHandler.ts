import { TASK_STATUSES } from '@orca/server/types';
import { useMutation } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../../api';
import { useToolModelSelection } from '../../../hooks/useToolModelSelection';
import { useWebSocket } from '../../../hooks/useWebSocket';
import { isKnownWSEvent } from '../../../types';

type Args = {
  taskId: string;
  taskStatus: string;
  isOperationRunning: (type: string, targetId?: string) => boolean;
};

export function useMergeHandler({
  taskId,
  taskStatus,
  isOperationRunning,
}: Args) {
  const mergeTaskMutation = useMutation({
    mutationFn: (args: {
      taskId: string;
      mode?: string;
      tool?: string;
      model?: string;
    }) => api.mergeTask(args.taskId, args.mode),
  });

  const [mergeProgress, setMergeProgress] = useState<string | null>(null);
  const [conflictError, setConflictError] = useState<string | null>(null);
  const [conflictWorktreePath, setConflictWorktreePath] = useState('');
  const [showManualResolve, setShowManualResolve] = useState(false);

  const {
    selectedTool: mergeTool,
    selectedModel: mergeModel,
    setSelectedTool: setMergeTool,
    setSelectedModel: setMergeModel,
    models: mergeModels,
    isFetching: mergeModelsFetching,
    handleToolChange: onMergeToolChange,
  } = useToolModelSelection();

  useEffect(() => {
    if (!taskId) return;
    setMergeProgress(null);
    setConflictError(null);
    setConflictWorktreePath('');
    setShowManualResolve(false);
    setMergeTool('');
    setMergeModel('');
  }, [setMergeModel, setMergeTool, taskId]);

  useEffect(() => {
    if (taskStatus !== TASK_STATUSES.merged) return;
    setMergeProgress(null);
    setConflictError(null);
    setConflictWorktreePath('');
    setShowManualResolve(false);
    setMergeTool('');
    setMergeModel('');
  }, [setMergeModel, setMergeTool, taskStatus]);

  useWebSocket(
    useCallback(
      (evt) => {
        if (!isKnownWSEvent(evt)) return;

        let evtTaskId: string | undefined;
        if (evt.type === 'merge.started' || evt.type === 'merge.failed') {
          evtTaskId = evt.data.taskId;
        } else if (evt.type === 'merge.progress') {
          evtTaskId = evt.data.taskId;
        } else if (evt.type === 'merge.completed') {
          evtTaskId = 'id' in evt.data ? evt.data.id : undefined;
        } else if (evt.type === 'task.updated') {
          evtTaskId = evt.data.id;
        }
        if (evtTaskId !== taskId) return;

        if (evt.type === 'merge.started') {
          setMergeProgress('Merge started...');
          setConflictError(null);
          setConflictWorktreePath('');
          setShowManualResolve(false);
        } else if (evt.type === 'merge.progress') {
          setMergeProgress(evt.data.message ?? 'Resolving...');
        } else if (evt.type === 'merge.completed') {
          setMergeProgress(null);
          setConflictError(null);
        } else if (evt.type === 'merge.failed') {
          setMergeProgress(null);
          const isConflict = Boolean(evt.data.conflict);
          if (isConflict) {
            setConflictError(evt.data.error);
            setConflictWorktreePath(evt.data.worktreePath ?? '');
          } else {
            setConflictError(null);
            setConflictWorktreePath('');
          }
        } else if (evt.type === 'task.updated') {
          const status = 'status' in evt.data ? evt.data.status : '';
          if (
            status === TASK_STATUSES.merged ||
            status === TASK_STATUSES.approved ||
            status === TASK_STATUSES.failed
          ) {
            setMergeProgress(null);
          }
        }
      },
      [taskId],
    ),
  );

  const onAutoResolve = async () => {
    setMergeProgress('Auto-resolve queued...');
    try {
      await mergeTaskMutation.mutateAsync({
        taskId,
        mode: 'auto',
        tool: mergeTool || undefined,
        model: mergeModel || undefined,
      });
    } catch {
      setMergeProgress(null);
    }
  };

  return {
    mergeTool,
    mergeModel,
    mergeModels,
    mergeModelsFetching,
    onMergeToolChange,
    onMergeModelChange: setMergeModel,
    onAutoResolve,
    mergeProgress,
    conflictError,
    conflictWorktreePath,
    showManualResolve,
    setShowManualResolve,
    merging: isOperationRunning('merge', taskId) || mergeTaskMutation.isPending,
  };
}
