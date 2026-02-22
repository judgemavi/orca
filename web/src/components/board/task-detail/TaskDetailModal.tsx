import { useEffect, useMemo, useState } from 'react'
import { Dialog, DialogClose, DialogContent } from '@tiny-bits/react-dialog'
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
import { useReviewQuery } from '../../../hooks/queries/useSprints'
import { StatusBadge } from '../../common/StatusBadge'
import { ActionButton } from '../../common/ActionButton'
import { TaskActionsBar } from './TaskActionsBar'
import { TaskMetaSection } from './TaskMetaSection'
import { TaskPlanSection } from './TaskPlanSection'
import { TaskReviewSection } from './TaskReviewSection'

interface Props {
  task: Task
  tools: string[]
  config: Config
  sprintId?: string
  lastWSEvent?: WSEvent | null
  isOperationRunning: (type: string, targetId?: string) => boolean
  onClose: () => void
  onSaved: () => void
  onDeleted: () => void
}

const controlClass =
  'w-full rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2.5 py-2 text-[13px] text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--accent)]'

type PhaseValues = Record<'plan' | 'sprint' | 'review', { tool: string; model: string }>

function buildDefaultPhaseValues(config: Config): PhaseValues {
  const tool = config.defaults?.tool ?? ''
  const model = config.defaults?.model ?? ''
  return {
    plan: { tool, model },
    sprint: { tool, model },
    review: { tool, model },
  }
}

function buildTaskPhaseValues(task: Task, config: Config): PhaseValues {
  if (task.phase_config?.phases) {
    const defaults = buildDefaultPhaseValues(config)
    return {
      plan: {
        tool: task.phase_config.phases.plan?.tool ?? defaults.plan.tool,
        model: task.phase_config.phases.plan?.model ?? defaults.plan.model,
      },
      sprint: {
        tool: task.phase_config.phases.sprint?.tool ?? defaults.sprint.tool,
        model: task.phase_config.phases.sprint?.model ?? defaults.sprint.model,
      },
      review: {
        tool: task.phase_config.phases.review?.tool ?? defaults.review.tool,
        model: task.phase_config.phases.review?.model ?? defaults.review.model,
      },
    }
  }

  if (task.phase_config?.use_defaults) {
    return buildDefaultPhaseValues(config)
  }

  const legacyTool = task.assigned_tool ?? ''
  const legacyModel = task.model ?? ''
  return {
    plan: { tool: legacyTool, model: legacyModel },
    sprint: { tool: legacyTool, model: legacyModel },
    review: { tool: legacyTool, model: legacyModel },
  }
}

function shouldUseDefaults(task: Task) {
  return task.phase_config?.use_defaults ?? true
}

function toPhaseOverride(value: { tool: string; model: string }) {
  const patch: { tool?: string; model?: string } = {}
  if (value.tool) patch.tool = value.tool
  if (value.model) patch.model = value.model
  return patch
}

export function TaskDetailModal({
  task,
  tools,
  config,
  sprintId,
  lastWSEvent,
  isOperationRunning,
  onClose,
  onSaved,
  onDeleted,
}: Props) {
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
        const sprintPhase = values.phases.sprint
        const compatTool = sprintPhase.tool || config.defaults?.tool || ''
        const compatModel = sprintPhase.model || config.defaults?.model || ''
        const phaseConfig = values.useDefaults
          ? { use_defaults: true }
          : {
              use_defaults: false,
              phases: {
                plan: toPhaseOverride(values.phases.plan),
                sprint: toPhaseOverride(values.phases.sprint),
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

  const effectiveSprintId = sprintId || task.sprint_id
  const reviewSprintId =
    ['review', 'completed', 'merged'].includes(task.status) && effectiveSprintId
      ? effectiveSprintId
      : ''
  const reviewQuery = useReviewQuery(reviewSprintId)
  const { data: reviewsData } = useQuery({
    queryKey: ['task-reviews', task.id],
    queryFn: () => api.getTaskReviews(task.id),
    enabled: ['review', 'completed', 'merged'].includes(task.status),
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
    if (!reviewQuery.data?.artifacts) return null
    return (
      reviewQuery.data.artifacts.find((item) => item.task_id === task.id) ??
      null
    )
  }, [reviewQuery.data?.artifacts, task.id])

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
        status === 'completed' ||
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

  return (
    <Dialog
      open
      modal
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="z-[100] m-0! flex max-h-[90vh] w-[560px] max-w-[95vw] flex-col overflow-y-auto rounded-[var(--radius)] border! border-[var(--border)]! bg-[var(--bg-primary)]! text-[var(--text-primary)] p-0! shadow-[0_8px_32px_rgba(0,0,0,0.16)]">
        <div className="flex items-center justify-between border-b border-[var(--border)] px-5 py-3">
          <div className="flex items-center gap-2.5">
            <StatusBadge status={task.status} />
            <span className="font-mono text-[11px] text-[var(--text-secondary)]">
              {task.id.slice(0, 8)}
            </span>
          </div>
          <DialogClose
            className="rounded px-1.5 py-1 text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]"
            aria-label="Close"
            type="button"
          >
            ✕
          </DialogClose>
        </div>

        <form
          className="flex flex-1 flex-col gap-3.5 p-5"
          onSubmit={(e) => {
            e.preventDefault()
            void form.handleSubmit()
          }}
        >
          <TaskMetaSection
            taskTitle={task.title}
            taskDependencies={task.depends_on ?? []}
            isEditable={isEditable}
            controlClass={controlClass}
            form={form}
            config={config}
          />

          <TaskPlanSection
            isEditable={isEditable}
            hasPlan={hasPlan}
            plan={plan}
            planDraft={planDraft}
            planEditing={planEditing}
            planGenerating={planGenerating}
            planLoading={planLoading}
            planSaving={planSaving}
            planError={planError}
            tools={tools}
            generateTool={generateTool}
            generateModel={generateModel}
            generationModels={generationModels}
            generateModelsFetching={generateModelsQuery.isFetching}
            generatePlanPending={generatePlanMutation.isPending}
            controlClass={controlClass}
            onStartEdit={() => {
              setPlanDraft(plan ?? '')
              setPlanEditing(true)
            }}
            onPlanDraftChange={setPlanDraft}
            onCancelEdit={() => {
              setPlanDraft(plan ?? '')
              setPlanEditing(false)
            }}
            onSavePlan={() => {
              void handleSavePlan()
            }}
            onRegeneratePlan={handleRegeneratePlan}
            onGenerateToolChange={(nextTool) => {
              setGenerateTool(nextTool)
              setGenerateModel('')
            }}
            onGenerateModelChange={setGenerateModel}
            onGeneratePlan={() => {
              void handleGeneratePlan()
            }}
          />

          <TaskReviewSection
            task={task}
            artifact={artifact}
            showDiff={showDiff}
            feedback={feedback}
            approving={approving}
            requesting={requesting}
            reviewActionError={reviewActionError}
            reviews={reviews}
            onToggleDiff={() => setShowDiff((v) => !v)}
            onFeedbackChange={setFeedback}
            onApprove={() => {
              void handleApprove()
            }}
            onRequestChanges={() => {
              void handleRequestChanges()
            }}
          />

          {mergeProgress && (
            <div className="flex flex-col gap-2 rounded-md border border-[#e0b4b4] bg-[#fff5f5] p-3">
              <div className="text-xs leading-5 text-[#8a1f1f]">
                {mergeProgress}
              </div>
            </div>
          )}

          {conflictError && !mergeProgress && (
            <div className="flex flex-col gap-2 rounded-md border border-[#e0b4b4] bg-[#fff5f5] p-3">
              <div className="text-xs leading-5 text-[#8a1f1f]">
                Merge conflict: {conflictError}
              </div>
              <div className="flex gap-2">
                <ActionButton
                  variant="primary"
                  onClick={() => {
                    void handleMerge('auto')
                  }}
                  disabled={merging}
                >
                  Auto-resolve
                </ActionButton>
                <ActionButton
                  variant="default"
                  onClick={() => setShowManualResolve(true)}
                >
                  Manual resolve
                </ActionButton>
              </div>
              {showManualResolve && (
                <div className="flex flex-col gap-1.5 text-xs text-[var(--text-secondary)]">
                  {conflictWorktreePath && (
                    <div className="font-mono text-[11px] text-[var(--text-primary)]">
                      Worktree: <code>{conflictWorktreePath}</code>
                    </div>
                  )}
                  <div>
                    Resolve conflicts in the worktree, commit the fixes, then
                    click Retry Merge.
                  </div>
                </div>
              )}
            </div>
          )}
        </form>

        <TaskActionsBar
          task={task}
          artifact={artifact}
          isEditable={isEditable}
          deleting={deleting}
          saving={saving}
          merging={merging}
          conflictError={conflictError}
          form={form}
          onDelete={() => {
            void handleDelete()
          }}
          onMerge={() => {
            void handleMerge()
          }}
          onClose={onClose}
        />
      </DialogContent>
    </Dialog>
  )
}
