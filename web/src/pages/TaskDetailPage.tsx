import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { StatusBadge } from '../components/common/StatusBadge'
import { TaskActionsBar } from '../components/board/task-detail/TaskActionsBar'
import { TaskTimeline } from '../components/board/task-detail/TaskTimeline'
import { useTaskDetail } from '../components/board/task-detail/useTaskDetail'
import { useTasksState } from '../components/board/useTasksState'
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
    artifact,
    artifacts,
    logs,
    logsLoading,
    artifactsLoading,
    reviews,
    showDiff,
    setShowDiff,
    feedback,
    setFeedback,
    approving,
    requesting,
    rerunning,
    reviewActionError,
    plan,
    planDraft,
    planEditing,
    planGenerating,
    planLoading,
    planSaving,
    planError,
    hasPlan,
    generateTool,
    generateModel,
    generationModels,
    generateModelsFetching,
    generatePlanPending,
    setPlanDraft,
    setPlanEditing,
    setGenerateTool,
    setGenerateModel,
    handleDelete,
    handleMerge,
    handleGeneratePlan,
    handleRegeneratePlan,
    handleSavePlan,
    handleApprove,
    handleRequestChanges,
    handleRerun,
    refetchArtifacts,
    refetchLogs,
  } = useTaskDetail({
    task,
    tools,
    lastWSEvent,
    isOperationRunning: isRunning,
    onClose: () => {
      void navigate({ to: '/' })
    },
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
      <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col overflow-hidden px-4 py-4">
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
          <form
            className="flex flex-1 flex-col gap-3.5 p-5"
            onSubmit={(e) => {
              e.preventDefault()
              void form.handleSubmit()
            }}
          >
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

            <TaskTimeline
              task={task}
              artifacts={artifacts}
              reviews={reviews}
              logs={logs}
              logsLoading={logsLoading}
              artifactsLoading={artifactsLoading}
              config={configData}
              artifact={artifact}
              showDiff={showDiff}
              feedback={feedback}
              approving={approving}
              requesting={requesting}
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
              onRefresh={() => {
                refetchArtifacts()
                refetchLogs()
              }}
              onToggleDiff={() => setShowDiff((v) => !v)}
              onFeedbackChange={setFeedback}
              onApprove={() => {
                void handleApprove()
              }}
              onRequestChanges={() => {
                void handleRequestChanges()
              }}
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
          </form>

          <TaskActionsBar
            isEditable={isEditable}
            isDeletable={isDeletable}
            deleting={deleting}
            saving={saving}
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
