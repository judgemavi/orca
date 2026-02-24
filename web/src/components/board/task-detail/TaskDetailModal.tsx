import { Dialog, DialogClose, DialogContent } from '@tiny-bits/react-dialog'
import { StatusBadge } from '../../common/StatusBadge'
import { TaskActionsBar } from './TaskActionsBar'
import { TaskMetaSection } from './TaskMetaSection'
import { TaskPlanSection } from './TaskPlanSection'
import { TaskReviewSection } from './TaskReviewSection'
import { TaskMergeStatus } from './TaskMergeStatus'
import { useTaskDetail } from './useTaskDetail'
import type { TaskDetailProps as Props } from './useTaskDetail'

export type { TaskDetailProps as Props } from './useTaskDetail'

const controlClass =
  'w-full rounded-md border border-[var(--border)] bg-[var(--bg-primary)] px-2.5 py-2 text-[13px] text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--accent)]'

export function TaskDetailModal(props: Props) {
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
    reviews,
    showDiff,
    setShowDiff,
    feedback,
    setFeedback,
    approving,
    requesting,
    reviewActionError,
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
  } = useTaskDetail(props)

  const { task, onClose } = props

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
            config={props.config}
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
            generateModelsFetching={generateModelsFetching}
            generatePlanPending={generatePlanPending}
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

          <TaskMergeStatus
            mergeProgress={mergeProgress}
            conflictError={conflictError}
            merging={merging}
            showManualResolve={showManualResolve}
            conflictWorktreePath={conflictWorktreePath}
            onAutoResolve={() => {
              void handleMerge('auto')
            }}
            onShowManualResolve={() => setShowManualResolve(true)}
          />
        </form>

        <TaskActionsBar
          task={task}
          artifact={artifact}
          isEditable={isEditable}
          isDeletable={isDeletable}
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
