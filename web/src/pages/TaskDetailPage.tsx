import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { useState } from 'react'
import { InteractionLogPanel } from '../components/board/task-detail/InteractionLogPanel'
import { TaskActionsBar } from '../components/board/task-detail/TaskActionsBar'
import { TaskTimeline } from '../components/board/task-detail/TaskTimeline'
import { useTaskDetail } from '../components/board/task-detail/useTaskDetail'
import { useTasksState } from '../components/board/useTasksState'
import { StatusBadge } from '../components/common/StatusBadge'
import { useLastWSEvent } from '../context/ws'
import type { Config, Task } from '../types'

const controlClass =
  'w-full rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2.5 py-2 text-[13px] text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--accent)]'

export function TaskDetailPage() {
  const { taskId } = useParams({ from: '/tasks/$taskId' })
  const {
    tasks,
    configData,
    loading,
    tools,
    isRunning,
    invalidateBoard,
  } = useTasksState()

  const task = tasks.find((item) => item.id === taskId)

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-border border-t-accent" />
      </div>
    )
  }

  if (!task || !configData) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-[var(--text-secondary)]">
        <span>Task not found.</span>
        <Link
          to="/"
          className="rounded border border-border px-3 py-1.5 text-[var(--text-primary)] hover:bg-[var(--bg-secondary)]"
        >
          Back to tasks
        </Link>
      </div>
    )
  }

  return (
    <TaskDetailContent
      task={task}
      configData={configData}
      tools={tools}
      isRunning={isRunning}
      invalidateBoard={invalidateBoard}
    />
  )
}

function TaskDetailContent({
  task,
  configData,
  tools,
  isRunning,
  invalidateBoard,
}: {
  task: Task
  configData: Config
  tools: string[]
  isRunning: (type: string, targetId?: string) => boolean
  invalidateBoard: () => Promise<void>
}) {
  const navigate = useNavigate()
  const lastWSEvent = useLastWSEvent()
  const [activeLogId, setActiveLogId] = useState<string | null>(null)

  const {
    form,
    saving,
    isEditable,
    isDeletable,
    deleting,
    merging,
    mergeProgress,
    conflictError,
    conflictWorktreePath,
    showManualResolve,
    setShowManualResolve,
    planInteractions,
    runInteractions,
    reviewInteractions,
    mergeInteractions,
    interactionsLoading,
    planReviews,
    runReviews,
    feedback,
    setFeedback,
    approving,
    requesting,
    aiReviewTool,
    aiReviewModel,
    aiReviewModels,
    aiReviewModelsFetching,
    aiReviewing,
    aiReviewExpanded,
    rerunning,
    reviewActionError,
    plan,
    planGenerating,
    planLoading,
    planError,
    approvingPlan,
    requestingPlanChanges,
    planFeedback,
    planReviewExpanded,
    hasPlan,
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
    handleDelete,
    handleMerge,
    handleRun,
    handleGeneratePlan,
    handleApprovePlan,
    handleRequestPlanChanges,
    handleApprove,
    handleRequestChanges,
    handleRerun,
    handleAIReview,
  } = useTaskDetail({
    task,
    tools,
    lastWSEvent,
    isOperationRunning: isRunning,
    onSaved: () => {
      void invalidateBoard()
    },
    onDeleted: () => {
      void navigate({ to: '/' })
      void invalidateBoard()
    },
  })

  return (
    <div className="flex flex-1 overflow-hidden">
      <div className="mx-auto flex w-full flex-1 flex-col overflow-hidden px-4 py-4">
        <div className="mb-3 flex items-center justify-between">
          <Link
            to="/"
            className="rounded border border-border px-3 py-1.5 text-xs font-medium text-[var(--text-primary)] hover:bg-[var(--bg-secondary)]"
          >
            ← Back to tasks
          </Link>
          <div className="flex items-center gap-2.5">
            <StatusBadge status={task.status} />
            <span className="font-mono text-[11px] text-[var(--text-secondary)]">
              {task.id.slice(0, 8)}
            </span>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-auto rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-primary)]">
          <div className="flex flex-1 flex-col gap-3.5 p-5">
            <form
              id="task-edit-form"
              onSubmit={(e) => {
                e.preventDefault()
                void form.handleSubmit()
              }}
            >
              <div className="flex flex-col gap-3.5">
                <form.Field name="title">
                  {(field) => (
                    <label className="flex flex-col gap-1.5 text-xs font-medium text-[var(--text-secondary)]">
                      Title
                      {isEditable ? (
                        <input
                          className={controlClass}
                          value={field.state.value}
                          onBlur={field.handleBlur}
                          onChange={(e) => field.handleChange(e.target.value)}
                        />
                      ) : (
                        <div className="rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-2 text-[13px] font-normal text-[var(--text-primary)]">
                          {field.state.value || task.title}
                        </div>
                      )}
                    </label>
                  )}
                </form.Field>

                <form.Field name="description">
                  {(field) => (
                    <label className="flex flex-col gap-1.5 text-xs font-medium text-[var(--text-secondary)]">
                      Description
                      {isEditable ? (
                        <textarea
                          className={controlClass}
                          value={field.state.value}
                          onBlur={field.handleBlur}
                          onChange={(e) => field.handleChange(e.target.value)}
                          rows={4}
                          placeholder="No description"
                        />
                      ) : (
                        <div className="min-h-[80px] whitespace-pre-wrap rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-2 text-[13px] font-normal text-[var(--text-primary)]">
                          {field.state.value || 'No description'}
                        </div>
                      )}
                    </label>
                  )}
                </form.Field>
              </div>
            </form>

            <div className="flex min-h-[420px] flex-col gap-4 lg:flex-row">
              <div
                className={[
                  'min-h-0 w-full transition-all duration-200',
                  activeLogId ? 'lg:w-3/5' : 'lg:w-full',
                ].join(' ')}
              >
                <TaskTimeline
                  task={task}
                  planInteractions={planInteractions}
                  runInteractions={runInteractions}
                  reviewInteractions={reviewInteractions}
                  mergeInteractions={mergeInteractions}
                  planReviews={planReviews}
                  runReviews={runReviews}
                  interactionsLoading={interactionsLoading}
                  config={configData}
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
                  mergeProgress={mergeProgress}
                  conflictError={conflictError}
                  merging={merging}
                  showManualResolve={showManualResolve}
                  conflictWorktreePath={conflictWorktreePath}
                  isPlanningEditable={isEditable}
                  hasPlan={hasPlan}
                  plan={plan}
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
                  runTool={runTool}
                  runModel={runModel}
                  runModels={runModels}
                  runModelsFetching={runModelsFetching}
                  runPending={runPending}
                  rerunTool={rerunTool}
                  rerunModel={rerunModel}
                  rerunModels={rerunModels}
                  rerunModelsFetching={rerunModelsFetching}
                  mergeTool={mergeTool}
                  mergeModel={mergeModel}
                  mergeModels={mergeModels}
                  mergeModelsFetching={mergeModelsFetching}
                  controlClass={controlClass}
                  onToggleLogPanel={(interactionId) => {
                    if (activeLogId === interactionId) {
                      setActiveLogId(null)
                      return
                    }
                    setActiveLogId(interactionId)
                  }}
                  onFeedbackChange={setFeedback}
                  onApprove={() => {
                    void handleApprove()
                  }}
                  onRequestChanges={(interactionId, tool, model) => {
                    void handleRequestChanges(interactionId, tool, model)
                  }}
                  onAIReview={() => {
                    void handleAIReview()
                  }}
                  onAIReviewToolChange={setAIReviewTool}
                  onAIReviewModelChange={setAIReviewModel}
                  onExpandAIReview={() => setAIReviewExpanded(true)}
                  onCancelAIReview={() => setAIReviewExpanded(false)}
                  onRerun={() => {
                    void handleRerun()
                  }}
                  onMerge={() => {
                    void handleMerge()
                  }}
                  onAutoResolve={() => {
                    void handleMerge('auto')
                  }}
                  onShowManualResolve={() => setShowManualResolve(true)}
                  onPlanFeedbackChange={setPlanFeedback}
                  onPlanReviewExpandedChange={setPlanReviewExpanded}
                  onGenerateToolChange={(nextTool) => {
                    setGenerateTool(nextTool)
                    setGenerateModel('')
                  }}
                  onGenerateModelChange={setGenerateModel}
                  onGeneratePlan={() => {
                    void handleGeneratePlan()
                  }}
                  onApprovePlan={() => {
                    void handleApprovePlan()
                  }}
                  onRequestPlanChanges={(interactionId, feedbackValue, tool, model) => {
                    void handleRequestPlanChanges(interactionId, feedbackValue, tool, model)
                  }}
                  onRun={() => {
                    void handleRun()
                  }}
                  onRunToolChange={(nextTool) => {
                    setRunTool(nextTool)
                    setRunModel('')
                  }}
                  onRunModelChange={setRunModel}
                  onRerunToolChange={(nextTool) => {
                    setRerunTool(nextTool)
                    setRerunModel('')
                  }}
                  onRerunModelChange={setRerunModel}
                  onMergeToolChange={(nextTool) => {
                    setMergeTool(nextTool)
                    setMergeModel('')
                  }}
                  onMergeModelChange={setMergeModel}
                />
              </div>

              {activeLogId && (
                <div className="min-h-0 w-full transform transition-all duration-200 ease-out lg:w-2/5">
                  <InteractionLogPanel
                    taskId={task.id}
                    interactionId={activeLogId}
                    onClose={() => {
                      setActiveLogId(null)
                    }}
                  />
                </div>
              )}
            </div>
          </div>

          <TaskActionsBar
            isEditable={isEditable}
            isDeletable={isDeletable}
            deleting={deleting}
            saving={saving}
            formId="task-edit-form"
            form={form}
            onDelete={() => {
              void handleDelete()
            }}
            onClose={() => {
              void navigate({ to: '/' })
            }}
          />
        </div>
      </div>
    </div>
  )
}
