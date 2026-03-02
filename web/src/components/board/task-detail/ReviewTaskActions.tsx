import { useTaskDetailContext } from '../../../context/TaskDetailContext'
import { Button } from '../../Button'
import { TaskActionsLayout, TaskFeedbackBox } from './TaskActionsLayout'
import { useTaskActions } from './useTaskActions'

export function ReviewTaskActions() {
  const { task } = useTaskDetailContext()
  const actions = useTaskActions(task)

  const showRequestChanges = actions.requestChangesExpanded
  const showAIReview = actions.aiReviewExpanded
  const showSelector = showRequestChanges || showAIReview

  let actionButtons = null
  if (showRequestChanges) {
    actionButtons = (
      <>
        <Button
          variant="default"
          onClick={() => {
            actions.setRequestChangesExpanded(false)
            actions.setAIFeedbackAppliedNotice(false)
            actions.setActionError(null)
          }}
          disabled={actions.phaseInProgress || actions.requestChangesPending}
        >
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={actions.handleRequestChanges}
          disabled={actions.phaseInProgress || actions.requestChangesPending}
        >
          {actions.requestChangesPending
            ? 'Submitting…'
            : 'Submit Request Changes'}
        </Button>
      </>
    )
  } else if (showAIReview) {
    actionButtons = (
      <>
        <Button
          variant="default"
          onClick={() => {
            actions.setAIReviewExpanded(false)
            actions.setAIReviewPrompt('')
            actions.setActionError(null)
          }}
          disabled={actions.phaseInProgress}
        >
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={actions.handleAIReview}
          disabled={actions.phaseInProgress}
        >
          {actions.aiReviewPending ? 'Reviewing…' : 'Start Review'}
        </Button>
      </>
    )
  } else {
    actionButtons = (
      <>
        <Button
          variant="primary"
          onClick={actions.handleApprove}
          disabled={
            actions.phaseInProgress ||
            actions.approvePending ||
            actions.requestChangesPending
          }
        >
          {actions.approvePending ? 'Approving…' : 'Approve'}
        </Button>
        <Button
          variant="default"
          onClick={() => {
            actions.setAIReviewExpanded(false)
            actions.setRequestChangesExpanded(true)
            actions.setAIFeedbackAppliedNotice(false)
            actions.setActionError(null)
          }}
          disabled={
            actions.phaseInProgress ||
            actions.approvePending ||
            actions.requestChangesPending
          }
        >
          Request Changes
        </Button>
        <Button
          variant="default"
          onClick={() => {
            actions.setRequestChangesExpanded(false)
            actions.setAIFeedbackAppliedNotice(false)
            actions.setAIReviewExpanded(true)
            actions.setActionError(null)
          }}
          disabled={actions.phaseInProgress || actions.approvePending}
        >
          {actions.aiReviewPending ? 'Reviewing…' : 'AI Review'}
        </Button>
      </>
    )
  }

  return (
    <TaskActionsLayout
      tools={actions.tools}
      actionTool={actions.actionTool}
      actionModel={actions.actionModel}
      actionModels={actions.actionModels}
      actionModelsFetching={actions.actionModelsFetching}
      onToolChange={actions.handleActionToolChange}
      onModelChange={actions.setActionModel}
      showToolModelSelector={showSelector}
      actionError={actions.actionError}
      feedback={
        showRequestChanges ? (
          <TaskFeedbackBox
            value={actions.requestFeedback}
            onChange={(value) => {
              actions.setRequestFeedback(value)
              actions.setAIFeedbackAppliedNotice(false)
            }}
            showNotice={actions.aiFeedbackAppliedNotice}
          />
        ) : showAIReview ? (
          <TaskFeedbackBox
            value={actions.aiReviewPrompt}
            onChange={actions.setAIReviewPrompt}
            placeholder="Focus areas or instructions... (optional)"
          />
        ) : null
      }
      actions={actionButtons}
    />
  )
}
