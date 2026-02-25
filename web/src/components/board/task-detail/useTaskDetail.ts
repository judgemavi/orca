import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Task, TaskEvaluation, WSEvent } from '../../../types'
import { api } from '../../../api'
import { useTaskForm } from '../../../hooks/forms/useTaskForm'
import { useModelsQuery } from '../../../hooks/queries/useModels'
import {
  useGeneratePlanMutation,
  useSavePlanMutation,
  useTaskPlanQuery,
} from '../../../hooks/queries/usePlan'
import {
  useInteractionsQuery,
} from './useInteractions'

export interface TaskDetailProps {
  task: Task
  tools: string[]
  lastWSEvent?: WSEvent | null
  isOperationRunning: (type: string, targetId?: string) => boolean
  onSaved: () => void
  onDeleted: () => void
}

export function useTaskDetail({
  task,
  tools,
  lastWSEvent,
  isOperationRunning,
  onSaved,
  onDeleted,
}: TaskDetailProps) {
  const onSavedRef = useRef(onSaved)
  onSavedRef.current = onSaved

  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [merging, setMerging] = useState(false)
  const [mergeProgress, setMergeProgress] = useState<string | null>(null)
  const [conflictError, setConflictError] = useState<string | null>(null)
  const [conflictWorktreePath, setConflictWorktreePath] = useState<string>('')
  const [showManualResolve, setShowManualResolve] = useState(false)
  const [approving, setApproving] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [requesting, setRequesting] = useState(false)
  const [rerunning, setRerunning] = useState(false)
  const [reviewActionError, setReviewActionError] = useState<string | null>(
    null,
  )
  const isEditable = task.status === 'pending'
  const isDeletable = task.status !== 'running' && task.status !== 'merged'

  const [plan, setPlan] = useState<string | null>(task.plan ?? null)
  const [planDraft, setPlanDraft] = useState('')
  const [planEditing, setPlanEditing] = useState(false)
  const [planGenerating, setPlanGenerating] = useState(false)
  const [planError, setPlanError] = useState<string | null>(null)
  const [approvingPlan, setApprovingPlan] = useState(false)
  const [requestingPlanChanges, setRequestingPlanChanges] = useState(false)
  const [planFeedback, setPlanFeedback] = useState('')
  const [planReviewExpanded, setPlanReviewExpanded] = useState(false)
  const [taskEvaluation, setTaskEvaluation] = useState<TaskEvaluation | null>(null)
  const [evaluatingTask, setEvaluatingTask] = useState(false)
  const [generateTool, setGenerateTool] = useState('')
  const [generateModel, setGenerateModel] = useState('')
  const [runTool, setRunTool] = useState('')
  const [runModel, setRunModel] = useState('')
  const [runPending, setRunPending] = useState(false)
  const [rerunTool, setRerunTool] = useState('')
  const [rerunModel, setRerunModel] = useState('')
  const [mergeTool, setMergeTool] = useState('')
  const [mergeModel, setMergeModel] = useState('')
  const [aiReviewTool, setAIReviewTool] = useState('')
  const [aiReviewModel, setAIReviewModel] = useState('')
  const [aiReviewing, setAIReviewing] = useState(false)
  const [aiReviewExpanded, setAIReviewExpanded] = useState(false)
  const [aiReviewPrompt, setAIReviewPrompt] = useState('')

  const form = useTaskForm(
    {
      title: task.title,
      description: task.description ?? '',
    },
    async (values) => {
      setSaving(true)
      try {
        await api.updateTask(task.id, {
          title: values.title.trim(),
          description: values.description.trim(),
        } as any)
        onSaved()
      } catch (err: any) {
        alert(err.message ?? 'Save failed')
      } finally {
        setSaving(false)
      }
    },
  )

  const generateModelsQuery = useModelsQuery(generateTool || undefined)
  const runModelsQuery = useModelsQuery(runTool || undefined)
  const rerunModelsQuery = useModelsQuery(rerunTool || undefined)
  const mergeModelsQuery = useModelsQuery(mergeTool || undefined)
  const aiReviewModelsQuery = useModelsQuery(aiReviewTool || undefined)
  const taskPlanQuery = useTaskPlanQuery(task.id)
  const savePlanMutation = useSavePlanMutation()
  const generatePlanMutation = useGeneratePlanMutation()

  const reviewsQuery = useQuery({
    queryKey: ['task-reviews', task.id],
    queryFn: () => api.getTaskReviews(task.id),
    enabled: Boolean(task.id),
  })
  const reviewsData = reviewsQuery.data
  const interactionsQuery = useInteractionsQuery(task.id)
  const reviews = useMemo(
    () =>
      [...(reviewsData?.reviews ?? [])].sort(
        (a, b) =>
          Date.parse(b.created_at || '') - Date.parse(a.created_at || ''),
      ),
    [reviewsData?.reviews],
  )
  const interactions = useMemo(
    () =>
      [...(interactionsQuery.data ?? [])].sort(
        (a, b) =>
          Date.parse(a.started_at || '') - Date.parse(b.started_at || ''),
      ),
    [interactionsQuery.data],
  )

  const runInteractions = useMemo(
    () => interactions.filter((item) => item.phase === 'run'),
    [interactions],
  )
  const planInteractions = useMemo(
    () => interactions.filter((item) => item.phase === 'plan'),
    [interactions],
  )
  const mergeInteractions = useMemo(
    () => interactions.filter((item) => item.phase === 'merge'),
    [interactions],
  )
  const reviewInteractions = useMemo(
    () => interactions.filter((item) => item.phase === 'review'),
    [interactions],
  )
  const planInteractionIDs = useMemo(
    () => new Set(planInteractions.map((item) => item.id)),
    [planInteractions],
  )
  const runInteractionIDs = useMemo(
    () => new Set(runInteractions.map((item) => item.id)),
    [runInteractions],
  )
  const planReviews = useMemo(
    () =>
      reviews.filter(
        (review) =>
          Boolean(review.interaction_id) &&
          planInteractionIDs.has(review.interaction_id as string),
      ),
    [reviews, planInteractionIDs],
  )
  const runReviews = useMemo(
    () =>
      reviews.filter(
        (review) =>
          Boolean(review.interaction_id) &&
          runInteractionIDs.has(review.interaction_id as string),
      ),
    [reviews, runInteractionIDs],
  )

  const generationModels = generateTool
    ? (generateModelsQuery.data?.[generateTool] ?? [])
    : []
  const runModels = runTool ? (runModelsQuery.data?.[runTool] ?? []) : []
  const rerunModels = rerunTool ? (rerunModelsQuery.data?.[rerunTool] ?? []) : []
  const mergeModels = mergeTool ? (mergeModelsQuery.data?.[mergeTool] ?? []) : []
  const aiReviewModels = aiReviewTool
    ? (aiReviewModelsQuery.data?.[aiReviewTool] ?? [])
    : []

  useEffect(() => {
    form.reset({
      title: task.title,
      description: task.description ?? '',
    })
    setPlan(task.plan ?? null)
    setPlanDraft('')
    setPlanEditing(false)
    setPlanError(null)
    setApprovingPlan(false)
    setRequestingPlanChanges(false)
    setPlanFeedback('')
    setPlanReviewExpanded(false)
    setTaskEvaluation(null)
    setEvaluatingTask(false)
    setGenerateTool('')
    setGenerateModel('')
    setRunTool('')
    setRunModel('')
    setRunPending(false)
    setRerunTool('')
    setRerunModel('')
    setMergeTool('')
    setMergeModel('')
    setAIReviewTool('')
    setAIReviewModel('')
    setAIReviewing(false)
    setAIReviewExpanded(false)
    setAIReviewPrompt('')
    setApproving(false)
    setFeedback('')
    setRequesting(false)
    setRerunning(false)
    setReviewActionError(null)
  }, [task, form])

  useEffect(() => {
    if (taskPlanQuery.data === undefined) return
    const nextPlan = taskPlanQuery.data || null
    setPlan(nextPlan)
    if (!planEditing) {
      setPlanDraft(nextPlan ?? '')
    }
  }, [taskPlanQuery.data, planEditing])

  useEffect(() => {
    const planInFlight = isOperationRunning('plan_generate', task.id)
    setPlanGenerating(planInFlight)
  }, [task.id, isOperationRunning])

  useEffect(() => {
    const mergeInFlight = isOperationRunning('merge', task.id)
    setMerging(mergeInFlight)
    if (mergeInFlight) {
      setMergeProgress((prev) => prev ?? 'Merge in progress...')
    } else {
      setMergeProgress((prev) =>
        prev === 'Merge in progress...' ? null : prev,
      )
    }
  }, [task.id, isOperationRunning])

  useEffect(() => {
    if (task.status !== 'merged') return
    setMerging(false)
    setMergeProgress(null)
    setConflictError(null)
    setConflictWorktreePath('')
    setShowManualResolve(false)
  }, [task.status])

  useEffect(() => {
    if (!lastWSEvent) return
    const evtTaskId =
      (lastWSEvent.data as any)?.task_id ?? (lastWSEvent.data as any)?.id
    if (evtTaskId !== task.id) return

    if (lastWSEvent.type === 'merge.started') {
      setMerging(true)
      setMergeProgress('Merge started...')
      setConflictError(null)
      setConflictWorktreePath('')
      setShowManualResolve(false)
    } else if (lastWSEvent.type === 'merge.progress') {
      setMergeProgress(
        String((lastWSEvent.data as any)?.message ?? 'Resolving...'),
      )
    } else if (lastWSEvent.type === 'merge.completed') {
      setMerging(false)
      setMergeProgress(null)
      setConflictError(null)
      onSavedRef.current()
    } else if (lastWSEvent.type === 'task.updated') {
      const status = String((lastWSEvent.data as any)?.status ?? '')
      reviewsQuery.refetch()
      if (
        status === 'merged' ||
        status === 'approved' ||
        status === 'failed'
      ) {
        setMerging(false)
        setMergeProgress(null)
      }
    } else if (lastWSEvent.type === 'merge.failed') {
      setMerging(false)
      setMergeProgress(null)
      const isConflict = Boolean((lastWSEvent.data as any)?.conflict)
      const errMsg = String((lastWSEvent.data as any)?.error ?? 'Merge failed')
      if (isConflict) {
        setConflictError(errMsg)
        setConflictWorktreePath(
          String((lastWSEvent.data as any)?.worktree_path ?? ''),
        )
      } else {
        setConflictError(null)
        setConflictWorktreePath('')
        alert(errMsg)
      }
    } else if (lastWSEvent.type === 'plan.generating') {
      setPlanGenerating(true)
      setPlanError(null)
    } else if (lastWSEvent.type === 'plan.completed') {
      const generatedPlan = String((lastWSEvent.data as any)?.plan ?? '')
      setPlan(generatedPlan || null)
      setPlanDraft(generatedPlan)
      setPlanEditing(false)
      setPlanGenerating(false)
      setPlanError(null)
    } else if (lastWSEvent.type === 'plan.failed') {
      setPlanGenerating(false)
      setPlanError(
        String((lastWSEvent.data as any)?.error ?? 'Failed to generate plan'),
      )
    } else if (
      lastWSEvent.type === 'ai-review.completed' ||
      lastWSEvent.type === 'interaction.completed'
    ) {
      const phase = (lastWSEvent.data as any)?.phase
      if (phase === 'review' || lastWSEvent.type === 'ai-review.completed') {
        setAIReviewing(false)
        interactionsQuery.refetch()
      }
    } else if (
      lastWSEvent.type === 'ai-review.failed' ||
      lastWSEvent.type === 'interaction.failed'
    ) {
      const phase = (lastWSEvent.data as any)?.phase
      if (phase === 'review' || lastWSEvent.type === 'ai-review.failed') {
        setAIReviewing(false)
        setReviewActionError(
          String((lastWSEvent.data as any)?.error ?? 'AI review failed'),
        )
        interactionsQuery.refetch()
      }
    }
  }, [lastWSEvent, task.id])

  const handleDelete = async () => {
    if (!confirm(`Delete "${task.title}"?`)) return
    setDeleting(true)
    try {
      await api.deleteTask(task.id)
      onDeleted()
    } catch (err: any) {
      alert(err.message ?? 'Delete failed')
    } finally {
      setDeleting(false)
    }
  }

  const handleMerge = async (mode?: string) => {
    setMerging(true)
    if (!mode) {
      setConflictError(null)
      setConflictWorktreePath('')
      setShowManualResolve(false)
      setMergeProgress('Merge started...')
    } else {
      setMergeProgress('Auto-resolve queued...')
    }
    try {
      await api.mergeTask(
        task.id,
        mode,
        mergeTool || undefined,
        mergeModel || undefined,
      )
    } catch (err: any) {
      alert(err.message ?? 'Merge failed')
      setMerging(false)
    }
  }

  const handleRun = async () => {
    setRunPending(true)
    setReviewActionError(null)
    try {
      await api.runTasks([task.id], runTool || undefined, runModel || undefined)
      onSaved()
    } catch (err: any) {
      setReviewActionError(err?.message ?? 'Run failed')
    } finally {
      setRunPending(false)
    }
  }

  const handleGeneratePlan = async () => {
    setPlanGenerating(true)
    setPlanError(null)
    try {
      await generatePlanMutation.mutateAsync({
        taskId: task.id,
        tool: generateTool || undefined,
        model: generateModel || undefined,
      })
    } catch (err: any) {
      setPlanError(err?.message ?? 'Failed to generate plan')
      setPlanGenerating(false)
    }
  }

  const handleSavePlan = async () => {
    setPlanError(null)
    try {
      await savePlanMutation.mutateAsync({ taskId: task.id, plan: planDraft })
      setPlan(planDraft || null)
      setPlanEditing(false)
      onSaved()
    } catch (err: any) {
      setPlanError(err?.message ?? 'Failed to save plan')
    }
  }

  const handleApprovePlan = async () => {
    setApprovingPlan(true)
    setPlanError(null)
    try {
      await api.approvePlan(task.id)
      setPlanReviewExpanded(false)
      onSaved()
    } catch (err: any) {
      setPlanError(err?.message ?? 'Approve plan failed')
    } finally {
      setApprovingPlan(false)
    }
  }

  const handleEvaluateTask = async () => {
    setEvaluatingTask(true)
    setPlanError(null)
    try {
      const response = await api.evaluateTask(
        task.id,
        generateTool || undefined,
        generateModel || undefined,
      )
      setTaskEvaluation(response.evaluation)
    } catch (err: any) {
      setPlanError(err?.message ?? 'Evaluate failed')
    } finally {
      setEvaluatingTask(false)
    }
  }

  const handleRequestPlanChanges = async (
    interactionId?: string,
    feedbackText?: string,
    tool?: string,
    model?: string,
  ) => {
    const trimmedFeedback = (feedbackText ?? planFeedback).trim()
    if (!trimmedFeedback) {
      setPlanError('Feedback is required')
      return
    }
    const trimmedInteractionID = (interactionId ?? '').trim()
    if (!trimmedInteractionID) {
      setPlanError('Interaction ID is required')
      return
    }

    setRequestingPlanChanges(true)
    setPlanError(null)
    try {
      await api.requestPlanChanges(
        task.id,
        trimmedFeedback,
        trimmedInteractionID,
        tool || generateTool || undefined,
        model || generateModel || undefined,
      )
      setPlanReviewExpanded(false)
      setPlanFeedback('')
    } catch (err: any) {
      setPlanError(err?.message ?? 'Request plan changes failed')
    } finally {
      setRequestingPlanChanges(false)
    }
  }

  const handleApprove = async () => {
    setApproving(true)
    setReviewActionError(null)
    try {
      await api.approveTask(task.id)
      onSaved()
    } catch (err: any) {
      setReviewActionError(err?.message ?? 'Approve failed')
    } finally {
      setApproving(false)
    }
  }

  const handleRequestChanges = async (
    interactionId?: string,
    tool?: string,
    model?: string,
  ) => {
    const trimmedFeedback = feedback.trim()
    if (!trimmedFeedback) {
      setReviewActionError('Feedback is required')
      return
    }

    setRequesting(true)
    setReviewActionError(null)
    try {
      await api.requestChanges(task.id, trimmedFeedback, interactionId, tool, model)
      onSaved()
    } catch (err: any) {
      setReviewActionError(err?.message ?? 'Request changes failed')
    } finally {
      setRequesting(false)
    }
  }

  const handleRerun = async () => {
    setRerunning(true)
    setReviewActionError(null)
    try {
      await api.runTasks([task.id], rerunTool || undefined, rerunModel || undefined)
      onSaved()
    } catch (err: any) {
      setReviewActionError(err?.message ?? 'Re-run failed')
    } finally {
      setRerunning(false)
    }
  }

  const handleAIReview = async () => {
    setAIReviewing(true)
    setReviewActionError(null)
    try {
      await api.aiReview(
        task.id,
        aiReviewTool || undefined,
        aiReviewModel || undefined,
        aiReviewPrompt.trim() || undefined,
      )
    } catch (err: any) {
      setAIReviewing(false)
      setReviewActionError(err?.message ?? 'AI review failed')
    }
  }

  const hasPlan = Boolean(plan?.trim())
  const planLoading = taskPlanQuery.isLoading
  const planSaving = savePlanMutation.isPending

  return {
    // form
    form,
    saving,

    // task state
    isEditable,
    isDeletable,
    deleting,

    // merge
    merging,
    mergeProgress,
    conflictError,
    conflictWorktreePath,
    showManualResolve,
    setShowManualResolve,

    // review
    interactions,
    planInteractions,
    runInteractions,
    mergeInteractions,
    reviewInteractions,
    planReviews,
    runReviews,
    interactionsLoading:
      interactionsQuery.isLoading ||
      interactionsQuery.isFetching,
    reviews,
    feedback,
    setFeedback,
    approving,
    requesting,
    rerunning,
    reviewActionError,
    aiReviewTool,
    aiReviewModel,
    aiReviewModels,
    aiReviewModelsFetching: aiReviewModelsQuery.isFetching,
    aiReviewing,
    aiReviewExpanded,
    aiReviewPrompt,

    // plan
    plan,
    planDraft,
    planEditing,
    planGenerating,
    planLoading,
    planSaving,
    planError,
    approvingPlan,
    requestingPlanChanges,
    planFeedback,
    planReviewExpanded,
    taskEvaluation,
    evaluatingTask,
    hasPlan,
    tools,
    generateTool,
    generateModel,
    generationModels,
    generateModelsFetching: generateModelsQuery.isFetching,
    generatePlanPending: generatePlanMutation.isPending,
    runTool,
    runModel,
    runModels,
    runModelsFetching: runModelsQuery.isFetching,
    runPending,
    rerunTool,
    rerunModel,
    rerunModels,
    rerunModelsFetching: rerunModelsQuery.isFetching,
    mergeTool,
    mergeModel,
    mergeModels,
    mergeModelsFetching: mergeModelsQuery.isFetching,
    setPlanDraft,
    setPlanEditing,
    setPlanFeedback,
    setPlanReviewExpanded,
    setGenerateTool,
    setGenerateModel,
    setRunTool,
    setRunModel,
    setRerunTool,
    setRerunModel,
    setMergeTool,
    setMergeModel,
    setAIReviewTool,
    setAIReviewModel,
    setAIReviewExpanded,
    setAIReviewPrompt,

    // handlers
    handleDelete,
    handleMerge,
    handleRun,
    handleGeneratePlan,
    handleEvaluateTask,
    handleSavePlan,
    handleApprovePlan,
    handleRequestPlanChanges,
    handleApprove,
    handleRequestChanges,
    handleRerun,
    handleAIReview,
    refetchInteractions: () => {
      void interactionsQuery.refetch()
    },
  }
}
