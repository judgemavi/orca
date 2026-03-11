import { INTERACTION_STATUSES, TASK_STATUSES } from '@orca/server/types';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  createElement,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { api } from '../api';
import { useTaskDetailContext } from '../context/TaskDetailContext';
import {
  parseInteractionOutputData,
  parseInteractionOutputResult,
} from '../lib/interactionOutput';
import { queryKeys } from '../lib/queryKeys';
import { getErrorMessage } from '../lib/utils';
import { isKnownWSEvent, type ProposedTask, type Task } from '../types';
import {
  selectByRunLike,
  selectByType,
  useInteractionsQuery,
} from './useInteractions';
import { useToolModelSelection } from './useToolModelSelection';
import { useWebSocket } from './useWebSocket';

async function sha256Hex(value: string): Promise<string> {
  const buffer = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function parseEvaluationDescriptionHash(output?: string | null): string | null {
  const data = parseInteractionOutputData(output);
  if (!data) return null;
  if (typeof data.descriptionHash !== 'string') return null;
  const hash = data.descriptionHash.trim();
  return hash || null;
}

function parseAIReviewResult(
  output?: string | null,
): { approved: boolean; feedback: string } | null {
  const data = parseInteractionOutputData(output);
  if (!data || typeof data.feedback !== 'string') return null;
  return {
    approved: parseInteractionOutputResult(output) === 'approved',
    feedback: data.feedback,
  };
}

function parseEvaluationNeedsBreakdown(output?: string | null): boolean | null {
  const data = parseInteractionOutputData(output);
  if (!data) return null;
  if (typeof data.needsBreakdown === 'boolean') return data.needsBreakdown;
  return null;
}

function useTaskActionsState(task: Task) {
  const queryClient = useQueryClient();
  const { tools, isOperationRunning } = useTaskDetailContext();
  const planInteractionsQuery = useInteractionsQuery(task.id, {
    select: selectByType('plan'),
  });
  const runInteractionsQuery = useInteractionsQuery(task.id, {
    select: selectByRunLike,
  });
  const evaluateInteractionsQuery = useInteractionsQuery(task.id, {
    select: selectByType('evaluate'),
  });
  const reviewInteractionsQuery = useInteractionsQuery(task.id, {
    select: selectByType('review'),
  });
  const breakdownInteractionsQuery = useInteractionsQuery(task.id, {
    select: selectByType('breakdown'),
  });
  const mergeInteractionsQuery = useInteractionsQuery(task.id, {
    select: selectByType('merge'),
  });

  const startTaskMutation = useMutation({
    mutationFn: (args: { taskId: string; tool?: string; model?: string }) =>
      api.startTasks([args.taskId], args.tool, args.model),
  });
  const approveMutation = useMutation({
    mutationFn: (taskId: string) => api.approveTask(taskId),
  });
  const stopTaskMutation = useMutation({
    mutationFn: (taskId: string) => api.stopTask(taskId),
  });
  const requestChangesMutation = useMutation({
    mutationFn: (args: {
      id: string;
      feedback: string;
      interactionId?: string;
      tool?: string;
      model?: string;
    }) =>
      api.requestChanges(
        args.id,
        args.feedback,
        args.interactionId,
        args.tool,
        args.model,
      ),
  });
  const mergeTaskMutation = useMutation({
    mutationFn: (args: { taskId: string }) => api.mergeTask(args.taskId),
  });
  const resumeTaskMutation = useMutation({
    mutationFn: (args: { taskId: string; feedback?: string }) =>
      api.resumeTask(args.taskId, {
        feedback: args.feedback,
      }),
  });
  const evaluateTaskMutation = useMutation({
    mutationFn: (args: { taskId: string; tool?: string; model?: string }) =>
      api.evaluateTask(args.taskId, args.tool, args.model),
  });
  const breakdownTaskMutation = useMutation({
    mutationFn: (args: { taskId: string; tool?: string; model?: string }) =>
      api.breakdownTask(args.taskId, args.tool, args.model),
  });
  const acceptBreakdownMutation = useMutation({
    mutationFn: (args: {
      taskId: string;
      interactionId: string;
      tasks?: ProposedTask[];
    }) => api.acceptBreakdown(args.taskId, args.interactionId, args.tasks),
  });
  const rejectBreakdownMutation = useMutation({
    mutationFn: (args: { taskId: string; interactionId: string }) =>
      api.rejectBreakdown(args.taskId, args.interactionId),
  });
  const resetMutation = useMutation({
    mutationFn: (args: {
      taskId: string;
      interactionId: string;
      enqueue?: boolean;
    }) => api.resetTask(args.taskId, args.interactionId, args.enqueue),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.task(task.id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.taskInteractions(task.id),
        }),
      ]);
    },
  });

  const [requestChangesExpanded, setRequestChangesExpanded] = useState(false);
  const [requestFeedback, setRequestFeedback] = useState('');
  const [aiReviewExpanded, setAIReviewExpanded] = useState(false);
  const [aiReviewPrompt, setAIReviewPrompt] = useState('');
  const [resumeFeedback, setResumeFeedback] = useState('');
  const [aiFeedbackAppliedNotice, setAIFeedbackAppliedNotice] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [evaluateStarted, setEvaluateStarted] = useState(false);
  const [breakdownStarted, setBreakdownStarted] = useState(false);
  const [currentDescriptionHash, setCurrentDescriptionHash] = useState('');
  const lastProcessedReviewInteractionIdRef = useRef<string | null>(null);
  const latestTaskStatusRef = useRef(task.status);

  const {
    selectedTool: actionTool,
    selectedModel: actionModel,
    setSelectedModel: setActionModel,
    models: actionModels,
    isFetching: actionModelsFetching,
    handleToolChange: handleActionToolChange,
  } = useToolModelSelection();

  const planInteractions = planInteractionsQuery.data ?? [];
  const runInteractions = runInteractionsQuery.data ?? [];
  const evaluateInteractions = evaluateInteractionsQuery.data ?? [];
  const reviewInteractions = reviewInteractionsQuery.data ?? [];
  const breakdownInteractions = breakdownInteractionsQuery.data ?? [];
  const mergeInteractions = mergeInteractionsQuery.data ?? [];

  const hideEvaluateAction =
    evaluateInteractions.some(
      (item) => item.status === INTERACTION_STATUSES.running,
    ) ||
    evaluateInteractions.some(
      (item) => item.status === INTERACTION_STATUSES.completed,
    );
  const evaluating =
    evaluateStarted ||
    evaluateInteractions.some(
      (item) => item.status === INTERACTION_STATUSES.running,
    );
  const breakingDown =
    breakdownStarted ||
    breakdownInteractions.some(
      (item) => item.status === INTERACTION_STATUSES.running,
    );

  useEffect(() => {
    let cancelled = false;
    void sha256Hex(`${task.title}\n${task.description}`)
      .then((hash) => {
        if (!cancelled) {
          setCurrentDescriptionHash(hash);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCurrentDescriptionHash('');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [task.title, task.description]);

  const latestCompletedEvaluate = useMemo(
    () =>
      [...evaluateInteractions]
        .reverse()
        .find((item) => item.status === INTERACTION_STATUSES.completed),
    [evaluateInteractions],
  );
  const latestEvaluationDescriptionHash = useMemo(
    () => parseEvaluationDescriptionHash(latestCompletedEvaluate?.output),
    [latestCompletedEvaluate?.output],
  );
  const latestEvaluateNeedsBreakdown = useMemo(
    () => parseEvaluationNeedsBreakdown(latestCompletedEvaluate?.output),
    [latestCompletedEvaluate?.output],
  );
  const hideBreakdownAction = latestEvaluateNeedsBreakdown !== true;
  const descriptionUnchangedSinceLastEvaluation =
    Boolean(latestEvaluationDescriptionHash) &&
    Boolean(currentDescriptionHash) &&
    latestEvaluationDescriptionHash === currentDescriptionHash;
  const evaluateDisabledReason = descriptionUnchangedSinceLastEvaluation
    ? 'Description unchanged since last evaluation'
    : undefined;

  const latestCompletedRunId = useMemo(
    () =>
      [...runInteractions]
        .reverse()
        .find((item) => item.status === INTERACTION_STATUSES.completed)?.id,
    [runInteractions],
  );
  const latestCompletedRunStartedAtMS = useMemo(() => {
    const latestCompletedRun = [...runInteractions]
      .reverse()
      .find((item) => item.status === INTERACTION_STATUSES.completed);
    if (!latestCompletedRun) return NaN;
    return Date.parse(latestCompletedRun.startedAt);
  }, [runInteractions]);
  const latestBreakdownProposals = useMemo(() => {
    const latest = [...breakdownInteractions]
      .reverse()
      .find((item) => item.status === INTERACTION_STATUSES.completed);
    if (!latest?.output) return null;
    const data = parseInteractionOutputData(latest.output);
    if (!data) return null;
    if (
      data.accepted ||
      data.rejected ||
      !Array.isArray(data.proposed) ||
      data.proposed.length === 0
    ) {
      return null;
    }
    return {
      interactionId: latest.id,
      proposed: data.proposed as ProposedTask[],
    };
  }, [breakdownInteractions]);

  const runningInProgress =
    task.status === TASK_STATUSES.running ||
    isOperationRunning('code', task.id);
  const runningBusy = runningInProgress || startTaskMutation.isPending;
  const pendingBusy =
    planInteractions.some(
      (item) => item.status === INTERACTION_STATUSES.running,
    ) ||
    evaluateInteractions.some(
      (item) => item.status === INTERACTION_STATUSES.running,
    ) ||
    breakdownInteractions.some(
      (item) => item.status === INTERACTION_STATUSES.running,
    ) ||
    isOperationRunning('evaluate', task.id) ||
    evaluateTaskMutation.isPending ||
    isOperationRunning('breakdown', task.id) ||
    breakingDown ||
    breakdownTaskMutation.isPending;
  const reviewBusy =
    reviewInteractions.some(
      (item) => item.status === INTERACTION_STATUSES.running,
    ) || isOperationRunning('review', task.id);
  const mergeBusy =
    mergeInteractions.some(
      (item) => item.status === INTERACTION_STATUSES.running,
    ) ||
    isOperationRunning('merge', task.id) ||
    mergeTaskMutation.isPending;
  const approvedBusy = mergeBusy;

  const operationInProgress =
    task.status === TASK_STATUSES.pending
      ? pendingBusy
      : task.status === TASK_STATUSES.review
        ? reviewBusy
        : task.status === TASK_STATUSES.approved
          ? approvedBusy
          : false;

  useEffect(() => {
    setRequestChangesExpanded(false);
    setRequestFeedback('');
    setAIReviewExpanded(false);
    setAIReviewPrompt('');
    setResumeFeedback('');
    setAIFeedbackAppliedNotice(false);
    setActionError(null);
    setEvaluateStarted(false);
    setBreakdownStarted(false);
  }, [task.id, task.status]);

  useEffect(() => {
    lastProcessedReviewInteractionIdRef.current = null;
  }, [task.id]);

  const applyAIReviewFeedback = (feedback: string) => {
    const hadExistingRequestText =
      requestChangesExpanded && requestFeedback.trim().length > 0;
    setRequestChangesExpanded(true);
    setAIReviewExpanded(false);
    setRequestFeedback(feedback);
    setAIFeedbackAppliedNotice(hadExistingRequestText);
  };

  const resetReviewUIState = () => {
    setRequestChangesExpanded(false);
    setRequestFeedback('');
    setAIReviewExpanded(false);
    setAIReviewPrompt('');
    setAIFeedbackAppliedNotice(false);
    setActionError(null);
    lastProcessedReviewInteractionIdRef.current = null;
  };

  useEffect(() => {
    latestTaskStatusRef.current = task.status;
  }, [task.status]);

  useWebSocket((evt) => {
    if (!isKnownWSEvent(evt)) return;
    if (evt.type === 'task.updated') {
      const nextStatus =
        'status' in evt.data && typeof evt.data.status === 'string'
          ? evt.data.status
          : null;
      if (evt.data.id === task.id) {
        if (
          latestTaskStatusRef.current === TASK_STATUSES.review &&
          nextStatus === TASK_STATUSES.running
        ) {
          resetReviewUIState();
        }
        if (nextStatus === TASK_STATUSES.broken_down) {
          void queryClient.invalidateQueries({
            queryKey: queryKeys.taskInteractions(task.id),
          });
          void queryClient.invalidateQueries({
            queryKey: queryKeys.task(task.id),
          });
          void queryClient.invalidateQueries({ queryKey: queryKeys.tasks });
        }
      }
      return;
    }
    if (evt.type === 'plan.failed' && evt.data.taskId === task.id) {
      setActionError(evt.data.error || 'Failed to generate plan');
      return;
    }
    if (evt.type === 'evaluate.started' && evt.data.taskId === task.id) {
      setEvaluateStarted(true);
      return;
    }
    if (evt.type === 'evaluate.completed' && evt.data.taskId === task.id) {
      setEvaluateStarted(false);
      setActionError(null);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.taskInteractions(task.id),
      });
      return;
    }
    if (evt.type === 'evaluate.failed' && evt.data.taskId === task.id) {
      setEvaluateStarted(false);
      setActionError(evt.data.error || 'Evaluate failed');
      void queryClient.invalidateQueries({
        queryKey: queryKeys.taskInteractions(task.id),
      });
      return;
    }
    if (evt.type === 'breakdown.started' && evt.data.taskId === task.id) {
      setBreakdownStarted(true);
      return;
    }
    if (evt.type === 'breakdown.completed' && evt.data.taskId === task.id) {
      setBreakdownStarted(false);
      setActionError(null);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.taskInteractions(task.id),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.task(task.id),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.tasks });
      return;
    }
    if (evt.type === 'breakdown.failed' && evt.data.taskId === task.id) {
      setBreakdownStarted(false);
      setActionError(evt.data.error || 'Breakdown failed');
      void queryClient.invalidateQueries({
        queryKey: queryKeys.taskInteractions(task.id),
      });
      return;
    }
    if (evt.type === 'ai_review.completed' && evt.data.taskId === task.id) {
      if (
        task.status === TASK_STATUSES.review &&
        !evt.data.approved &&
        evt.data.feedback
      ) {
        applyAIReviewFeedback(evt.data.feedback);
      }
    }
  });

  useEffect(() => {
    if (task.status !== TASK_STATUSES.review) return;
    const latestCompletedReview = reviewInteractions.find((item) => {
      if (item.status !== INTERACTION_STATUSES.completed) return false;
      if (!Number.isFinite(latestCompletedRunStartedAtMS)) return true;
      return Date.parse(item.startedAt) > latestCompletedRunStartedAtMS;
    });
    if (!latestCompletedReview) return;
    if (
      lastProcessedReviewInteractionIdRef.current === latestCompletedReview.id
    ) {
      return;
    }
    const reviewResult = parseAIReviewResult(latestCompletedReview.output);
    if (reviewResult && !reviewResult.approved && reviewResult.feedback) {
      applyAIReviewFeedback(reviewResult.feedback);
    }
    lastProcessedReviewInteractionIdRef.current = latestCompletedReview.id;
  }, [latestCompletedRunStartedAtMS, reviewInteractions, task.id, task.status]);

  const refreshTaskState = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks }),
      queryClient.invalidateQueries({
        queryKey: queryKeys.taskInteractions(task.id),
      }),
      queryClient.invalidateQueries({ queryKey: queryKeys.operations() }),
    ]);
  };

  const handleStart = async () => {
    setActionError(null);
    try {
      await startTaskMutation.mutateAsync({
        taskId: task.id,
        tool: actionTool || undefined,
        model: actionModel || undefined,
      });
    } catch (err: unknown) {
      setActionError(getErrorMessage(err, 'Start failed'));
    }
  };

  const handleApprove = async () => {
    setActionError(null);
    try {
      await approveMutation.mutateAsync(task.id);
    } catch (err: unknown) {
      setActionError(getErrorMessage(err, 'Approve failed'));
    }
  };

  const handleStop = async () => {
    setActionError(null);
    try {
      await stopTaskMutation.mutateAsync(task.id);
    } catch (err: unknown) {
      setActionError(getErrorMessage(err, 'Stop failed'));
      await refreshTaskState();
    }
  };

  const handleResume = async () => {
    setActionError(null);
    try {
      await resumeTaskMutation.mutateAsync({
        taskId: task.id,
        feedback: resumeFeedback.trim() || undefined,
      });
      setResumeFeedback('');
    } catch (err: unknown) {
      setActionError(getErrorMessage(err, 'Resume failed'));
    }
  };

  const handleRequestChanges = async () => {
    const trimmedFeedback = requestFeedback.trim();
    if (!trimmedFeedback) {
      setActionError('Feedback is required');
      return;
    }

    setActionError(null);
    try {
      await requestChangesMutation.mutateAsync({
        id: task.id,
        feedback: trimmedFeedback,
        interactionId: latestCompletedRunId,
        tool: actionTool || undefined,
        model: actionModel || undefined,
      });
      setAIFeedbackAppliedNotice(false);
      setRequestChangesExpanded(false);
      setRequestFeedback('');
    } catch (err: unknown) {
      setActionError(getErrorMessage(err, 'Request changes failed'));
    }
  };

  const handleEvaluateTask = () => {
    setActionError(null);
    evaluateTaskMutation.mutate(
      {
        taskId: task.id,
        tool: actionTool || undefined,
        model: actionModel || undefined,
      },
      {
        onError: (err: unknown) => {
          setActionError(getErrorMessage(err, 'Evaluate failed'));
        },
      },
    );
  };

  const handleBreakdownTask = () => {
    setActionError(null);
    breakdownTaskMutation.mutate(
      {
        taskId: task.id,
        tool: actionTool || undefined,
        model: actionModel || undefined,
      },
      {
        onError: (err: unknown) => {
          setActionError(getErrorMessage(err, 'Breakdown failed'));
        },
      },
    );
  };

  const handleAcceptBreakdown = async (
    interactionId: string,
    tasks?: ProposedTask[],
  ) => {
    setActionError(null);
    try {
      await acceptBreakdownMutation.mutateAsync({
        taskId: task.id,
        interactionId,
        tasks,
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks }),
        queryClient.invalidateQueries({ queryKey: queryKeys.task(task.id) }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.taskInteractions(task.id),
        }),
      ]);
    } catch (err: unknown) {
      setActionError(getErrorMessage(err, 'Accept breakdown failed'));
    }
  };

  const handleRejectBreakdown = async (interactionId: string) => {
    setActionError(null);
    try {
      await rejectBreakdownMutation.mutateAsync({
        taskId: task.id,
        interactionId,
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.task(task.id) }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.taskInteractions(task.id),
        }),
      ]);
    } catch (err: unknown) {
      setActionError(getErrorMessage(err, 'Reject breakdown failed'));
    }
  };

  const handleReset = async (interactionId: string) => {
    setActionError(null);
    try {
      await resetMutation.mutateAsync({
        taskId: task.id,
        interactionId,
      });
    } catch (err: unknown) {
      setActionError(getErrorMessage(err, 'Reset failed'));
    }
  };

  const handleResetAndRun = async (interactionId: string) => {
    setActionError(null);
    try {
      await resetMutation.mutateAsync({
        taskId: task.id,
        interactionId,
        enqueue: true,
      });
    } catch (err: unknown) {
      setActionError(getErrorMessage(err, 'Reset & run failed'));
    }
  };

  const handleMerge = async () => {
    setActionError(null);
    try {
      await mergeTaskMutation.mutateAsync({
        taskId: task.id,
      });
    } catch (err: unknown) {
      setActionError(getErrorMessage(err, 'Merge failed'));
    }
  };

  return {
    tools,
    actionTool,
    actionModel,
    setActionModel,
    actionModels,
    actionModelsFetching,
    handleActionToolChange,
    actionError,
    setActionError,
    hideEvaluateAction,
    hideBreakdownAction,
    evaluateDisabledReason,
    descriptionUnchangedSinceLastEvaluation,
    evaluating,
    breakingDown,
    latestBreakdownProposals,
    operationInProgress,
    runningBusy,
    requestChangesExpanded,
    setRequestChangesExpanded,
    requestFeedback,
    setRequestFeedback,
    aiReviewExpanded,
    setAIReviewExpanded,
    aiReviewPrompt,
    setAIReviewPrompt,
    resumeFeedback,
    setResumeFeedback,
    aiFeedbackAppliedNotice,
    setAIFeedbackAppliedNotice,
    startTaskPending: startTaskMutation.isPending,
    approvePending: approveMutation.isPending,
    stopPending: stopTaskMutation.isPending,
    requestChangesPending: requestChangesMutation.isPending,
    mergePending: mergeTaskMutation.isPending,
    mergeInProgress: mergeBusy,
    resumePending: resumeTaskMutation.isPending,
    evaluatePending: evaluateTaskMutation.isPending,
    breakdownPending: breakdownTaskMutation.isPending,
    acceptBreakdownPending: acceptBreakdownMutation.isPending,
    rejectBreakdownPending: rejectBreakdownMutation.isPending,
    handleStart,
    handleApprove,
    handleStop,
    handleResume,
    handleRequestChanges,
    handleEvaluateTask,
    handleBreakdownTask,
    handleAcceptBreakdown,
    handleRejectBreakdown,
    handleMerge,
    handleReset,
    handleResetAndRun,
    resetPending: resetMutation.isPending,
  };
}

type TaskActionsValue = ReturnType<typeof useTaskActionsState>;

const TaskActionsContext = createContext<TaskActionsValue | null>(null);

export function TaskActionsProvider({ children }: { children: ReactNode }) {
  const { task } = useTaskDetailContext();
  const value = useTaskActionsState(task);

  return createElement(TaskActionsContext.Provider, { value }, children);
}

export function useTaskActions() {
  const context = useContext(TaskActionsContext);
  if (!context) {
    throw new Error('useTaskActions must be used within TaskActionsProvider');
  }
  return context;
}
