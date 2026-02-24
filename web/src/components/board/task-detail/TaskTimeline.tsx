import { TaskExecutionSection } from './TaskExecutionSection'
import { TaskMergeStatus } from './TaskMergeStatus'
import { TaskPlanSection } from './TaskPlanSection'
import { TimelinePhase } from './TimelinePhase'
import type { Config, Interaction, Task, TaskReview } from '../../../types'

type PhaseState = 'disabled' | 'active' | 'completed'

interface Props {
  task: Task
  planInteractions: Interaction[]
  runInteractions: Interaction[]
  reviewInteractions: Interaction[]
  mergeInteractions: Interaction[]
  planReviews: TaskReview[]
  runReviews: TaskReview[]
  interactionsLoading: boolean
  config: Config
  activeLogId: string | null
  feedback: string
  approving: boolean
  requesting: boolean
  aiReviewExpanded: boolean
  aiReviewing: boolean
  aiReviewTool: string
  aiReviewModel: string
  aiReviewModels: Array<{ id: string; name: string }>
  aiReviewModelsFetching: boolean
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
  planGenerating: boolean
  planLoading: boolean
  planError: string | null
  approvingPlan: boolean
  requestingPlanChanges: boolean
  planFeedback: string
  planReviewExpanded: boolean
  tools: string[]
  generateTool: string
  generateModel: string
  generationModels: Array<{ id: string; name: string }>
  generateModelsFetching: boolean
  generatePlanPending: boolean
  runTool: string
  runModel: string
  runModels: Array<{ id: string; name: string }>
  runModelsFetching: boolean
  runPending: boolean
  rerunTool: string
  rerunModel: string
  rerunModels: Array<{ id: string; name: string }>
  rerunModelsFetching: boolean
  mergeTool: string
  mergeModel: string
  mergeModels: Array<{ id: string; name: string }>
  mergeModelsFetching: boolean
  controlClass: string
  onToggleLogPanel: (interactionId: string) => void
  onFeedbackChange: (value: string) => void
  onApprove: () => void
  onRequestChanges: (interactionId?: string, tool?: string, model?: string) => void
  onAIReview: () => void
  onAIReviewToolChange: (value: string) => void
  onAIReviewModelChange: (value: string) => void
  onExpandAIReview: () => void
  onCancelAIReview: () => void
  onRerun: () => void
  onMerge: () => void
  onAutoResolve: () => void
  onShowManualResolve: () => void
  onPlanFeedbackChange: (value: string) => void
  onPlanReviewExpandedChange: (value: boolean) => void
  onGenerateToolChange: (value: string) => void
  onGenerateModelChange: (value: string) => void
  onGeneratePlan: () => void
  onApprovePlan: () => void
  onRequestPlanChanges: (
    interactionId?: string,
    feedback?: string,
    tool?: string,
    model?: string,
  ) => void
  onRun: () => void
  onRunToolChange: (value: string) => void
  onRunModelChange: (value: string) => void
  onRerunToolChange: (value: string) => void
  onRerunModelChange: (value: string) => void
  onMergeToolChange: (value: string) => void
  onMergeModelChange: (value: string) => void
}

function stateFor(task: Task, phase: 'planning' | 'execution' | 'merge'): PhaseState {
  if (phase === 'planning') {
    return task.status === 'pending' ? 'active' : 'completed'
  }

  if (phase === 'execution') {
    if (task.status === 'pending') return 'disabled'
    if (task.status === 'planned') return 'active'
    if (task.status === 'running' || task.status === 'review' || task.status === 'failed') {
      return 'active'
    }
    if (task.status === 'approved' || task.status === 'merged') return 'completed'
    return 'disabled'
  }

  if (phase === 'merge') {
    if (task.status === 'approved') return 'active'
    if (task.status === 'merged') return 'completed'
    return 'disabled'
  }

  return 'disabled'
}

export function TaskTimeline({
  task,
  planInteractions,
  runInteractions,
  reviewInteractions,
  mergeInteractions,
  planReviews,
  runReviews,
  interactionsLoading,
  config,
  activeLogId,
  feedback,
  approving,
  requesting,
  aiReviewExpanded,
  aiReviewing,
  aiReviewTool,
  aiReviewModel,
  aiReviewModels,
  aiReviewModelsFetching,
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
  planGenerating,
  planLoading,
  planError,
  approvingPlan,
  requestingPlanChanges,
  planFeedback,
  planReviewExpanded,
  tools,
  generateTool,
  generateModel,
  generationModels,
  generateModelsFetching,
  generatePlanPending,
  runTool,
  runModel,
  runModels,
  runModelsFetching,
  runPending,
  rerunTool,
  rerunModel,
  rerunModels,
  rerunModelsFetching,
  mergeTool,
  mergeModel,
  mergeModels,
  mergeModelsFetching,
  controlClass,
  onToggleLogPanel,
  onFeedbackChange,
  onApprove,
  onRequestChanges,
  onAIReview,
  onAIReviewToolChange,
  onAIReviewModelChange,
  onExpandAIReview,
  onCancelAIReview,
  onRerun,
  onMerge,
  onAutoResolve,
  onShowManualResolve,
  onPlanFeedbackChange,
  onPlanReviewExpandedChange,
  onGenerateToolChange,
  onGenerateModelChange,
  onGeneratePlan,
  onApprovePlan,
  onRequestPlanChanges,
  onRun,
  onRunToolChange,
  onRunModelChange,
  onRerunToolChange,
  onRerunModelChange,
  onMergeToolChange,
  onMergeModelChange,
}: Props) {
  const taskForPhaseState = { ...task, plan: plan ?? task.plan }
  const planningState = stateFor(taskForPhaseState, 'planning')
  const executionState = stateFor(taskForPhaseState, 'execution')
  const mergeState = stateFor(taskForPhaseState, 'merge')
  const hasDefaultTool = (config.tools?.length ?? 0) > 0

  return (
    <div className="relative pl-8">
      <div className="absolute left-3 top-0 bottom-0 w-px bg-[var(--border)]" />

      <TimelinePhase phase="planning" state={planningState}>
        {!hasDefaultTool && (
          <div className="mb-2 text-[11px] text-[var(--text-secondary)]">
            No tool configured.
          </div>
        )}
        <TaskPlanSection
          canGenerate={isPlanningEditable && !hasPlan}
          canReviewPlan={isPlanningEditable && hasPlan}
          readOnly={planningState !== 'active'}
          hasPlan={hasPlan}
          planGenerating={planGenerating}
          planLoading={planLoading}
          planError={planError}
          approvingPlan={approvingPlan}
          requestingPlanChanges={requestingPlanChanges}
          planFeedback={planFeedback}
          planReviewExpanded={planReviewExpanded}
          tools={tools}
          generateTool={generateTool}
          generateModel={generateModel}
          generationModels={generationModels}
          generateModelsFetching={generateModelsFetching}
          generatePlanPending={generatePlanPending}
          controlClass={controlClass}
          planInteractions={planInteractions}
          reviews={planReviews}
          activeLogId={activeLogId}
          onToggleLog={onToggleLogPanel}
          onPlanFeedbackChange={onPlanFeedbackChange}
          onPlanReviewExpandedChange={onPlanReviewExpandedChange}
          onGenerateToolChange={onGenerateToolChange}
          onGenerateModelChange={onGenerateModelChange}
          onGeneratePlan={onGeneratePlan}
          onApprovePlan={onApprovePlan}
          onRequestPlanChanges={onRequestPlanChanges}
        />
      </TimelinePhase>

      <TimelinePhase phase="execution" state={executionState}>
        <TaskExecutionSection
          task={task}
          tools={tools}
          runTool={runTool}
          runModel={runModel}
          runModels={runModels}
          runModelsFetching={runModelsFetching}
          runPending={runPending}
          runInteractions={runInteractions}
          reviewInteractions={reviewInteractions}
          interactionsLoading={interactionsLoading}
          activeLogId={activeLogId}
          feedback={feedback}
          approving={approving}
          requesting={requesting}
          aiReviewExpanded={aiReviewExpanded}
          aiReviewing={aiReviewing}
          aiReviewTool={aiReviewTool}
          aiReviewModel={aiReviewModel}
          aiReviewModels={aiReviewModels}
          aiReviewModelsFetching={aiReviewModelsFetching}
          rerunning={rerunning}
          reviewActionError={reviewActionError}
          reviews={runReviews}
          rerunTool={rerunTool}
          rerunModel={rerunModel}
          rerunModels={rerunModels}
          rerunModelsFetching={rerunModelsFetching}
          controlClass={controlClass}
          readOnly={executionState !== 'active'}
          onToggleLog={onToggleLogPanel}
          onFeedbackChange={onFeedbackChange}
          onApprove={onApprove}
          onRequestChanges={onRequestChanges}
          onAIReview={onAIReview}
          onAIReviewToolChange={onAIReviewToolChange}
          onAIReviewModelChange={onAIReviewModelChange}
          onExpandAIReview={onExpandAIReview}
          onCancelAIReview={onCancelAIReview}
          onRun={onRun}
          onRerun={onRerun}
          onRunToolChange={onRunToolChange}
          onRunModelChange={onRunModelChange}
          onRerunToolChange={onRerunToolChange}
          onRerunModelChange={onRerunModelChange}
        />
      </TimelinePhase>

      <TimelinePhase phase="merge" state={mergeState}>
        <TaskMergeStatus
          tools={tools}
          mergeTool={mergeTool}
          mergeModel={mergeModel}
          mergeModels={mergeModels}
          mergeModelsFetching={mergeModelsFetching}
          controlClass={controlClass}
          mergeProgress={mergeProgress}
          conflictError={conflictError}
          merging={merging}
          showManualResolve={showManualResolve}
          conflictWorktreePath={conflictWorktreePath}
          mergeInteractions={mergeInteractions}
          activeLogId={activeLogId}
          readOnly={mergeState !== 'active'}
          onToggleLog={onToggleLogPanel}
          onMerge={onMerge}
          onAutoResolve={onAutoResolve}
          onShowManualResolve={onShowManualResolve}
          onMergeToolChange={onMergeToolChange}
          onMergeModelChange={onMergeModelChange}
        />
      </TimelinePhase>
    </div>
  )
}
