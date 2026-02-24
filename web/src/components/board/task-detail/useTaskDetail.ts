import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Config, Task, ReviewArtifact, WSEvent } from '../../../types'
import { api } from '../../../api'
import { useTaskForm } from '../../../hooks/forms/useTaskForm'
import { useModelsQuery } from '../../../hooks/queries/useModels'
import {
  useGeneratePlanMutation,
  useSavePlanMutation,
  useTaskPlanQuery,
} from '../../../hooks/queries/usePlan'
import {
  buildTaskPhaseValues,
  shouldUseDefaults,
  toPhaseOverride,
} from './taskDetailUtils'

export interface TaskDetailProps {
  task: Task
  tools: string[]
  config: Config
  lastWSEvent?: WSEvent | null
  isOperationRunning: (type: string, targetId?: string) => boolean
  onClose: () => void
  onSaved: () => void
  onDeleted: () => void
}

export function useTaskDetail({
  task,
  tools,
  config,
  lastWSEvent,
  isOperationRunning,
  onClose,
  onSaved,
  onDeleted,
}: TaskDetailProps) {
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [merging, setMerging] = useState(false)
  const [mergeProgress, setMergeProgress] = useState<string | null>(null)
  const [conflictError, setConflictError] = useState<string | null>(null)
  const [conflictWorktreePath, setConflictWorktreePath] = useState<string>('')
  const [showManualResolve, setShowManualResolve] = useState(false)
  const [showDiff, setShowDiff] = useState(false)
  const [approving, setApproving] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [requesting, setRequesting] = useState(false)
  const [reviewActionError, setReviewActionError] = useState<string | null>(
    null,
  )
  const isEditable = task.status === 'pending' || task.status === 'failed'
  const isDeletable = task.status !== 'running' && task.status !== 'merged'

  const [plan, setPlan] = useState<string | null>(task.plan ?? null)
  const [planDraft, setPlanDraft] = useState('')
  const [planEditing, setPlanEditing] = useState(false)
  const [planGenerating, setPlanGenerating] = useState(false)
  const [planError, setPlanError] = useState<string | null>(null)
  const [generateTool, setGenerateTool] = useState(task.assigned_tool ?? '')
  const [generateModel, setGenerateModel] = useState(task.model ?? '')

  const form = useTaskForm(
    {
      title: task.title,
      description: task.description ?? '',
      useDefaults: shouldUseDefaults(task),
      phases: buildTaskPhaseValues(task, config),
    },
    async (values) => {
      setSaving(true)
      try {
        const runPhase = values.phases.run
        const compatTool = runPhase.tool || config.defaults?.tool || ''
        const compatModel = runPhase.model || config.defaults?.model || ''
        const phaseConfig = values.useDefaults
          ? { use_defaults: true }
          : {
              use_defaults: false,
              phases: {
                plan: toPhaseOverride(values.phases.plan),
                run: toPhaseOverride(values.phases.run),
                review: toPhaseOverride(values.phases.review),
              },
            }

        await api.updateTask(task.id, {
          title: values.title.trim(),
          description: values.description.trim(),
          assigned_tool: compatTool || undefined,
          model: compatModel || undefined,
          phase_config: phaseConfig,
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
  const taskPlanQuery = useTaskPlanQuery(task.id)
  const savePlanMutation = useSavePlanMutation()
  const generatePlanMutation = useGeneratePlanMutation()

  const { data: reviewsData } = useQuery({
    queryKey: ['task-reviews', task.id],
    queryFn: () => api.getTaskReviews(task.id),
    enabled: ['review', 'approved', 'merged'].includes(task.status),
  })
  const reviews = useMemo(
    () =>
      [...(reviewsData?.reviews ?? [])].sort(
        (a, b) =>
          Date.parse(b.created_at || '') - Date.parse(a.created_at || ''),
      ),
    [reviewsData?.reviews],
  )

  const artifact = useMemo<ReviewArtifact | null>(() => {
    return null
  }, [])

  const generationModels = generateTool
    ? (generateModelsQuery.data?.[generateTool] ?? [])
    : []

  useEffect(() => {
    form.reset({
      title: task.title,
      description: task.description ?? '',
      useDefaults: shouldUseDefaults(task),
      phases: buildTaskPhaseValues(task, config),
    })
    setPlan(task.plan ?? null)
    setPlanDraft('')
    setPlanEditing(false)
    setPlanError(null)
    setGenerateTool(task.assigned_tool ?? '')
    setGenerateModel(task.model ?? '')
    setApproving(false)
    setFeedback('')
    setRequesting(false)
    setReviewActionError(null)
  }, [task, form, config])

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
      onSaved()
    } else if (lastWSEvent.type === 'task.updated') {
      const status = String((lastWSEvent.data as any)?.status ?? '')
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
    }
  }, [lastWSEvent, task.id, onSaved])

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
      await api.mergeTask(task.id, mode)
    } catch (err: any) {
      alert(err.message ?? 'Merge failed')
      setMerging(false)
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

  const handleRegeneratePlan = () => {
    if (
      !confirm(
        'Regenerate plan? This will replace your current working plan draft.',
      )
    )
      return
    void handleGeneratePlan()
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

  const handleRequestChanges = async () => {
    const trimmedFeedback = feedback.trim()
    if (!trimmedFeedback) {
      setReviewActionError('Feedback is required')
      return
    }

    setRequesting(true)
    setReviewActionError(null)
    try {
      await api.requestChanges(task.id, trimmedFeedback)
      onSaved()
      onClose()
    } catch (err: any) {
      setReviewActionError(err?.message ?? 'Request changes failed')
    } finally {
      setRequesting(false)
    }
  }

  const hasPlan = Boolean(plan)
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
    artifact,
    reviews,
    showDiff,
    setShowDiff,
    feedback,
    setFeedback,
    approving,
    requesting,
    reviewActionError,

    // plan
    plan,
    planDraft,
    planEditing,
    planGenerating,
    planLoading,
    planSaving,
    planError,
    hasPlan,
    tools,
    generateTool,
    generateModel,
    generationModels,
    generateModelsFetching: generateModelsQuery.isFetching,
    generatePlanPending: generatePlanMutation.isPending,
    setPlanDraft,
    setPlanEditing,
    setGenerateTool,
    setGenerateModel,

    // handlers
    handleDelete,
    handleMerge,
    handleGeneratePlan,
    handleRegeneratePlan,
    handleSavePlan,
    handleApprove,
    handleRequestChanges,
  }
}
