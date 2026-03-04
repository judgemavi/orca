import { INTERACTION_STATUSES, PHASES, TASK_STATUSES } from '@orca/types';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../../api';
import { useTaskDetailContext } from '../../../context/TaskDetailContext';
import { useTaskPlanQuery } from '../../../hooks/queries';
import { useToolModelSelection } from '../../../hooks/useToolModelSelection';
import { useWebSocket } from '../../../hooks/useWebSocket';
import { queryKeys } from '../../../lib/queryKeys';
import { getErrorMessage } from '../../../lib/utils';
import {
  type AIReviewResult,
  isKnownWSEvent,
  type ProposedTask,
  type Task,
} from '../../../types';
import {
  selectByPhase,
  selectByRunLike,
  useInteractionsQuery,
} from './useInteractions';

async function sha256Hex(value: string): Promise<string> {
  const buffer = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function parseEvaluationDescriptionHash(qualityJSON?: string): string | null {
  if (!qualityJSON) return null;
  try {
    const parsed = JSON.parse(qualityJSON) as { descriptionHash?: unknown };
    if (typeof parsed.descriptionHash !== 'string') return null;
    const hash = parsed.descriptionHash.trim();
    return hash || null;
  } catch {
    return null;
  }
}

function parseAIReviewResult(qualityJSON?: string): AIReviewResult | null {
  if (!qualityJSON) return null;
  try {
    const parsed = JSON.parse(qualityJSON) as {
      taskId?: unknown;
      approved?: unknown;
      feedback?: unknown;
      tool?: unknown;
      prompt?: unknown;
    };
    if (typeof parsed.taskId !== 'string') return null;
    if (typeof parsed.approved !== 'boolean') return null;
    if (typeof parsed.feedback !== 'string') return null;
    if (typeof parsed.tool !== 'string') return null;
    if (parsed.prompt != null && typeof parsed.prompt !== 'string') return null;
    return {
      taskId: parsed.taskId,
      approved: parsed.approved,
      feedback: parsed.feedback,
      tool: parsed.tool,
      prompt: typeof parsed.prompt === 'string' ? parsed.prompt : undefined,
    };
  } catch {
    return null;
  }
}

function parseEvaluationNeedsBreakdown(qualityJSON?: string): boolean | null {
  if (!qualityJSON) return null;
  try {
    const parsed = JSON.parse(qualityJSON) as { needsBreakdown?: unknown };
    if (typeof parsed.needsBreakdown === 'boolean') {
      return parsed.needsBreakdown;
    }
    return null;
  } catch {
    return null;
  }
}

export function useTaskActions(task: Task) {
  const queryClient = useQueryClient();
  const { tools, isOperationRunning } = useTaskDetailContext();
  const taskPlanQuery = useTaskPlanQuery(task.id);
  const planInteractionsQuery = useInteractionsQuery(task.id, {
    select: selectByPhase(PHASES.plan),
  });
  const runInteractionsQuery = useInteractionsQuery(task.id, {
    select: selectByRunLike,
  });
  const evaluateInteractionsQuery = useInteractionsQuery(task.id, {
    select: selectByPhase(PHASES.evaluate),
  });
  const reviewInteractionsQuery = useInteractionsQuery(task.id, {
    select: selectByPhase(PHASES.review),
  });
  const breakdownInteractionsQuery = useInteractionsQuery(task.id, {
    select: selectByPhase(PHASES.breakdown),
  });
  const mergeInteractionsQuery = useInteractionsQuery(task.id, {
    select: selectByPhase(PHASES.merge),
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
  const aiReviewMutation = useMutation({
    mutationFn: (args: {
      taskId: string;
      tool?: string;
      model?: string;
      prompt?: string;
    }) => api.aiReview(args.taskId, args.tool, args.model, args.prompt),
  });
  const mergeTaskMutation = useMutation({
    mutationFn: (args: { taskId: string; tool?: string; model?: string }) =>
      api.mergeTask(args.taskId, undefined, args.tool, args.model),
  });
  const resumeTaskMutation = useMutation({
    mutationFn: (args: {
      taskId: string;
      sessionId?: string;
      feedback?: string;
    }) =>
      api.resumeTask(args.taskId, {
        sessionId: args.sessionId,
        feedback: args.feedback,
      }),
  });
  const generateTaskPlanMutation = useMutation({
    mutationFn: (args: { taskId: string; tool?: string; model?: string }) =>
      api.generateTaskPlan(args.taskId, { tool: args.tool, model: args.model }),
  });
  const approvePlanMutation = useMutation({
    mutationFn: (taskId: string) => api.approvePlan(taskId),
  });
  const requestPlanChangesMutation = useMutation({
    mutationFn: (args: {
      id: string;
      feedback: string;
      interactionId?: string;
      tool?: string;
      model?: string;
    }) =>
      api.requestPlanChanges(
        args.id,
        args.feedback,
        args.interactionId,
        args.tool,
        args.model,
      ),
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

  const [requestChangesExpanded, setRequestChangesExpanded] = useState(false);
  const [requestFeedback, setRequestFeedback] = useState('');
  const [requestPlanChangesExpanded, setRequestPlanChangesExpanded] =
    useState(false);
  const [requestPlanFeedback, setRequestPlanFeedback] = useState('');
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

  const planLoading = taskPlanQuery.isLoading;
  const planGenerating = isOperationRunning('plan_generate', task.id);
  const hasPlanInteraction = planInteractions.length > 0;
  const hideEvaluateAction =
    hasPlanInteraction || planGenerating || generateTaskPlanMutation.isPending;
  const hasPlan =
    typeof taskPlanQuery.data === 'string' &&
    taskPlanQuery.data.trim().length > 0;
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
    () => parseEvaluationDescriptionHash(latestCompletedEvaluate?.qualityJson),
    [latestCompletedEvaluate?.qualityJson],
  );
  const latestEvaluateNeedsBreakdown = useMemo(
    () => parseEvaluationNeedsBreakdown(latestCompletedEvaluate?.qualityJson),
    [latestCompletedEvaluate?.qualityJson],
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
    const latestCompletedRun = runInteractions.find(
      (item) => item.status === INTERACTION_STATUSES.completed,
    );
    if (!latestCompletedRun) return NaN;
    return Date.parse(latestCompletedRun.startedAt);
  }, [runInteractions]);
  const latestCompletedPlanId = useMemo(
    () =>
      [...planInteractions]
        .reverse()
        .find((item) => item.status === INTERACTION_STATUSES.completed)?.id,
    [planInteractions],
  );
  const latestBreakdownProposals = useMemo(() => {
    const latest = [...breakdownInteractions]
      .reverse()
      .find((item) => item.status === INTERACTION_STATUSES.completed);
    if (!latest?.qualityJson) return null;
    try {
      const parsed = JSON.parse(latest.qualityJson) as {
        accepted?: unknown;
        rejected?: unknown;
        proposed?: ProposedTask[];
      };
      if (
        parsed.accepted ||
        parsed.rejected ||
        !Array.isArray(parsed.proposed) ||
        parsed.proposed.length === 0
      ) {
        return null;
      }
      return {
        interactionId: latest.id,
        proposed: parsed.proposed,
      };
    } catch {
      return null;
    }
  }, [breakdownInteractions]);

  const runningInProgress =
    task.status === TASK_STATUSES.running ||
    isOperationRunning(PHASES.run, task.id);
  const runningBusy = runningInProgress || startTaskMutation.isPending;
  const pendingPhaseInProgress =
    planInteractions.some(
      (item) => item.status === INTERACTION_STATUSES.running,
    ) ||
    evaluateInteractions.some(
      (item) => item.status === INTERACTION_STATUSES.running,
    ) ||
    breakdownInteractions.some(
      (item) => item.status === INTERACTION_STATUSES.running,
    ) ||
    planGenerating ||
    generateTaskPlanMutation.isPending ||
    isOperationRunning(PHASES.evaluate, task.id) ||
    evaluateTaskMutation.isPending ||
    isOperationRunning(PHASES.breakdown, task.id) ||
    breakingDown ||
    breakdownTaskMutation.isPending;
  const reviewPhaseInProgress =
    reviewInteractions.some(
      (item) => item.status === INTERACTION_STATUSES.running,
    ) ||
    isOperationRunning(PHASES.review, task.id) ||
    aiReviewMutation.isPending;
  const mergePhaseInProgress =
    mergeInteractions.some(
      (item) => item.status === INTERACTION_STATUSES.running,
    ) ||
    isOperationRunning(PHASES.merge, task.id) ||
    mergeTaskMutation.isPending;
  const approvedPhaseInProgress = mergePhaseInProgress;

  const phaseInProgress =
    task.status === TASK_STATUSES.pending
      ? pendingPhaseInProgress
      : task.status === TASK_STATUSES.review
        ? reviewPhaseInProgress
        : task.status === TASK_STATUSES.approved
          ? approvedPhaseInProgress
          : false;

  useEffect(() => {
    setRequestChangesExpanded(false);
    setRequestFeedback('');
    setRequestPlanChangesExpanded(false);
    setRequestPlanFeedback('');
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
      if (
        evt.data.id === task.id &&
        latestTaskStatusRef.current === TASK_STATUSES.review &&
        nextStatus === TASK_STATUSES.running
      ) {
        resetReviewUIState();
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
    const reviewResult = parseAIReviewResult(latestCompletedReview.qualityJson);
    if (
      reviewResult &&
      reviewResult.taskId === task.id &&
      !reviewResult.approved &&
      reviewResult.feedback
    ) {
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
    const sessionId = task.sessionId?.trim() ?? '';
    if (!sessionId) {
      setActionError('Task has no session ID to resume');
      return;
    }

    setActionError(null);
    try {
      await resumeTaskMutation.mutateAsync({
        taskId: task.id,
        sessionId,
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

  const handleGeneratePlan = async () => {
    setActionError(null);
    try {
      await generateTaskPlanMutation.mutateAsync({
        taskId: task.id,
        tool: actionTool || undefined,
        model: actionModel || undefined,
      });
    } catch (err: unknown) {
      setActionError(getErrorMessage(err, 'Failed to generate plan'));
    }
  };

  const handleApprovePlan = async () => {
    setActionError(null);
    try {
      await approvePlanMutation.mutateAsync(task.id);
      setRequestPlanChangesExpanded(false);
      setRequestPlanFeedback('');
    } catch (err: unknown) {
      setActionError(getErrorMessage(err, 'Approve plan failed'));
    }
  };

  const handleRequestPlanChanges = async () => {
    const trimmedFeedback = requestPlanFeedback.trim();
    if (!trimmedFeedback) {
      setActionError('Feedback is required');
      return;
    }
    if (!latestCompletedPlanId) {
      setActionError('Interaction ID is required');
      return;
    }

    setActionError(null);
    try {
      await requestPlanChangesMutation.mutateAsync({
        id: task.id,
        feedback: trimmedFeedback,
        interactionId: latestCompletedPlanId,
        tool: actionTool || undefined,
        model: actionModel || undefined,
      });
      setRequestPlanChangesExpanded(false);
      setRequestPlanFeedback('');
    } catch (err: unknown) {
      setActionError(getErrorMessage(err, 'Request plan changes failed'));
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

  const handleAIReview = async () => {
    setActionError(null);
    try {
      await aiReviewMutation.mutateAsync({
        taskId: task.id,
        tool: actionTool || undefined,
        model: actionModel || undefined,
        prompt: aiReviewPrompt.trim() || undefined,
      });
      setAIReviewExpanded(false);
      setAIReviewPrompt('');
    } catch (err: unknown) {
      setActionError(getErrorMessage(err, 'AI review failed'));
    }
  };

  const handleMerge = async () => {
    setActionError(null);
    try {
      await mergeTaskMutation.mutateAsync({
        taskId: task.id,
        tool: actionTool || undefined,
        model: actionModel || undefined,
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
    hasPlan,
    planLoading,
    planGenerating,
    hideEvaluateAction,
    hideBreakdownAction,
    evaluateDisabledReason,
    descriptionUnchangedSinceLastEvaluation,
    evaluating,
    breakingDown,
    latestBreakdownProposals,
    phaseInProgress,
    runningBusy,
    requestChangesExpanded,
    setRequestChangesExpanded,
    requestFeedback,
    setRequestFeedback,
    requestPlanChangesExpanded,
    setRequestPlanChangesExpanded,
    requestPlanFeedback,
    setRequestPlanFeedback,
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
    aiReviewPending: aiReviewMutation.isPending,
    mergePending: mergeTaskMutation.isPending,
    mergeInProgress: mergePhaseInProgress,
    resumePending: resumeTaskMutation.isPending,
    generatePlanPending: generateTaskPlanMutation.isPending,
    approvePlanPending: approvePlanMutation.isPending,
    requestPlanChangesPending: requestPlanChangesMutation.isPending,
    evaluatePending: evaluateTaskMutation.isPending,
    breakdownPending: breakdownTaskMutation.isPending,
    acceptBreakdownPending: acceptBreakdownMutation.isPending,
    rejectBreakdownPending: rejectBreakdownMutation.isPending,
    handleStart,
    handleApprove,
    handleStop,
    handleResume,
    handleRequestChanges,
    handleGeneratePlan,
    handleApprovePlan,
    handleRequestPlanChanges,
    handleEvaluateTask,
    handleBreakdownTask,
    handleAcceptBreakdown,
    handleRejectBreakdown,
    handleAIReview,
    handleMerge,
  };
}
