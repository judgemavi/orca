import { TaskExecutionSection } from './TaskExecutionSection'
import { TaskMergeStatus } from './TaskMergeStatus'
import { TaskPlanSection } from './TaskPlanSection'
import { TaskReviewSection } from './TaskReviewSection'
import { TimelinePhase } from './TimelinePhase'
import type { Artifact, Config, ReviewArtifact, Task, TaskReview } from '../../../types'

type PhaseState = 'disabled' | 'active' | 'completed'

interface Props {
  task: Task
  artifacts: Artifact[]
  reviews: TaskReview[]
  logs: string[]
  logsLoading: boolean
  artifactsLoading: boolean
  config: Config
  artifact: ReviewArtifact | null
  showDiff: boolean
  feedback: string
  approving: boolean
  requesting: boolean
  rerunning: boolean
  reviewActionError: string | null
  mergeProgress: string | null
  conflictError: string | null
  merging: boolean
  showManualResolve: boolean
  conflictWorktreePath: string
  isPlanningEditable: boolean
  hasPlan: boolean
  plan: string | null
  planDraft: string
  planEditing: boolean
  planGenerating: boolean
  planLoading: boolean
  planSaving: boolean
  planError: string | null
  tools: string[]
  generateTool: string
  generateModel: string
  generationModels: Array<{ id: string; name: string }>
  generateModelsFetching: boolean
  generatePlanPending: boolean
  controlClass: string
  onRefresh: () => void
  onToggleDiff: () => void
  onFeedbackChange: (value: string) => void
  onApprove: () => void
  onRequestChanges: () => void
  onRerun: () => void
  onMerge: () => void
  onAutoResolve: () => void
  onShowManualResolve: () => void
  onStartEdit: () => void
  onPlanDraftChange: (value: string) => void
  onCancelEdit: () => void
  onSavePlan: () => void
  onRegeneratePlan: () => void
  onGenerateToolChange: (value: string) => void
  onGenerateModelChange: (value: string) => void
  onGeneratePlan: () => void
}

function stateFor(taskStatus: Task['status'], phase: 'planning' | 'execution' | 'review' | 'merge'): PhaseState {
  const sequence: Array<'planning' | 'execution' | 'review' | 'merge'> = [
    'planning',
    'execution',
    'review',
    'merge',
  ]

  const activeByStatus: Record<Task['status'], 'planning' | 'execution' | 'review' | 'merge'> = {
    pending: 'planning',
    running: 'execution',
    review: 'review',
    failed: 'review',
    approved: 'merge',
    merged: 'merge',
  }

  const active = activeByStatus[taskStatus]
  const phaseIndex = sequence.indexOf(phase)
  const activeIndex = sequence.indexOf(active)

  if (phaseIndex < activeIndex) return 'completed'
  if (phaseIndex === activeIndex) return taskStatus === 'merged' ? 'completed' : 'active'
  return 'disabled'
}

export function TaskTimeline({
  task,
  artifacts,
  reviews,
  logs,
  logsLoading,
  artifactsLoading,
  config,
  artifact,
  showDiff,
  feedback,
  approving,
  requesting,
  rerunning,
  reviewActionError,
  mergeProgress,
  conflictError,
  merging,
  showManualResolve,
  conflictWorktreePath,
  isPlanningEditable,
  hasPlan,
  plan,
  planDraft,
  planEditing,
  planGenerating,
  planLoading,
  planSaving,
  planError,
  tools,
  generateTool,
  generateModel,
  generationModels,
  generateModelsFetching,
  generatePlanPending,
  controlClass,
  onRefresh,
  onToggleDiff,
  onFeedbackChange,
  onApprove,
  onRequestChanges,
  onRerun,
  onMerge,
  onAutoResolve,
  onShowManualResolve,
  onStartEdit,
  onPlanDraftChange,
  onCancelEdit,
  onSavePlan,
  onRegeneratePlan,
  onGenerateToolChange,
  onGenerateModelChange,
  onGeneratePlan,
}: Props) {
  const planningState = stateFor(task.status, 'planning')
  const executionState = stateFor(task.status, 'execution')
  const reviewState = stateFor(task.status, 'review')
  const mergeState = stateFor(task.status, 'merge')
  const hasDefaultTool = Boolean(config.defaults?.tool)

  return (
    <div className="relative pl-8">
      <div className="absolute left-3 top-0 bottom-0 w-px bg-[var(--border)]" />

      <TimelinePhase phase="planning" state={planningState}>
        {!hasDefaultTool && (
          <div className="mb-2 text-[11px] text-[var(--text-secondary)]">
            No default tool configured.
          </div>
        )}
        <TaskPlanSection
          isEditable={isPlanningEditable}
          readOnly={planningState !== 'active'}
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
          generateModelsFetching={generateModelsFetching}
          generatePlanPending={generatePlanPending}
          controlClass={controlClass}
          onStartEdit={onStartEdit}
          onPlanDraftChange={onPlanDraftChange}
          onCancelEdit={onCancelEdit}
          onSavePlan={onSavePlan}
          onRegeneratePlan={onRegeneratePlan}
          onGenerateToolChange={onGenerateToolChange}
          onGenerateModelChange={onGenerateModelChange}
          onGeneratePlan={onGeneratePlan}
        />
      </TimelinePhase>

      <TimelinePhase phase="execution" state={executionState}>
        <TaskExecutionSection
          task={task}
          artifacts={artifacts}
          logs={logs}
          logsLoading={logsLoading}
          artifactsLoading={artifactsLoading}
          readOnly={executionState !== 'active'}
          onRefresh={onRefresh}
        />
      </TimelinePhase>

      <TimelinePhase phase="review" state={reviewState}>
        <TaskReviewSection
          task={task}
          artifact={artifact}
          showDiff={showDiff}
          feedback={feedback}
          approving={approving}
          requesting={requesting}
          rerunning={rerunning}
          reviewActionError={reviewActionError}
          reviews={reviews}
          readOnly={reviewState !== 'active'}
          onToggleDiff={onToggleDiff}
          onFeedbackChange={onFeedbackChange}
          onApprove={onApprove}
          onRequestChanges={onRequestChanges}
          onRerun={onRerun}
        />
      </TimelinePhase>

      <TimelinePhase phase="merge" state={mergeState}>
        <TaskMergeStatus
          mergeProgress={mergeProgress}
          conflictError={conflictError}
          merging={merging}
          showManualResolve={showManualResolve}
          conflictWorktreePath={conflictWorktreePath}
          readOnly={mergeState !== 'active'}
          onMerge={onMerge}
          onAutoResolve={onAutoResolve}
          onShowManualResolve={onShowManualResolve}
        />
      </TimelinePhase>
    </div>
  )
}
