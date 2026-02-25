import { useMemo, useState } from 'react'
import { ActionButton } from '../../common/ActionButton'
import { ToolModelSelector } from '../../common/ToolModelSelector'
import { useTaskDetailContext } from '../../../context/TaskDetailContext'

export function InlineReviewActions() {
  const {
    tools,
    controlClass,
    feedback,
    setFeedback,
    approving,
    requesting,
    aiReviewExpanded,
    aiReviewing,
    aiReviewTool,
    setAIReviewTool,
    aiReviewModel,
    setAIReviewModel,
    aiReviewModels,
    aiReviewModelsFetching,
    aiReviewPrompt,
    setAIReviewPrompt,
    reviewActionError,
    rerunTool,
    setRerunTool,
    rerunModel,
    setRerunModel,
    rerunModels,
    rerunModelsFetching,
    runInteractions,
    handleApprove,
    handleRequestChanges,
    handleAIReview,
    setAIReviewExpanded,
  } = useTaskDetailContext()
  const [reviewExpanded, setReviewExpanded] = useState(false)

  const interactionId = useMemo(
    () => [...runInteractions].reverse().find((item) => item.status === 'completed')?.id,
    [runInteractions],
  )

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {!reviewExpanded && !aiReviewExpanded && (
          <ActionButton variant="primary" onClick={handleApprove} disabled={approving || requesting}>
            {approving ? 'Approving…' : 'Approve'}
          </ActionButton>
        )}
        {!reviewExpanded && !aiReviewExpanded && (
          <ActionButton
            variant="default"
            onClick={() => {
              setAIReviewExpanded(false)
              setReviewExpanded(true)
            }}
            disabled={approving || requesting}
          >
            Request Changes
          </ActionButton>
        )}
        {!reviewExpanded && !aiReviewExpanded && (
          <ActionButton
            variant="default"
            onClick={() => {
              setReviewExpanded(false)
              setAIReviewExpanded(true)
            }}
            disabled={approving || requesting || aiReviewing}
          >
            {aiReviewing ? 'Reviewing…' : 'AI Review'}
          </ActionButton>
        )}
      </div>

      {reviewExpanded && (
        <div className="flex flex-col gap-2">
          <textarea
            id="request-changes-feedback"
            className="w-full resize-y rounded-md border border-[var(--border)] bg-[var(--bg-primary)] p-2 text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
            rows={3}
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="Describe what needs to be changed..."
          />
          <ToolModelSelector
            tools={tools}
            selectedTool={rerunTool}
            selectedModel={rerunModel}
            models={rerunModels}
            modelsFetching={rerunModelsFetching}
            onToolChange={(tool) => {
              setRerunTool(tool)
              setRerunModel('')
            }}
            onModelChange={setRerunModel}
            controlClass={controlClass}
            toolPlaceholder="- phase/default tool"
            modelPlaceholder="- default model"
          />
          <div className="flex justify-end gap-2">
            <ActionButton
              variant="default"
              onClick={() =>
                handleRequestChanges(interactionId, rerunTool || undefined, rerunModel || undefined)
              }
              disabled={requesting || approving}
            >
              {requesting ? 'Submitting…' : 'Submit Request Changes'}
            </ActionButton>
            <ActionButton
              variant="default"
              onClick={() => setReviewExpanded(false)}
              disabled={requesting || approving}
            >
              Cancel
            </ActionButton>
          </div>
        </div>
      )}

      {aiReviewExpanded && (
        <div className="flex flex-col gap-2">
          <textarea
            className="w-full resize-y rounded-md border border-[var(--border)] bg-[var(--bg-primary)] p-2 text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
            rows={2}
            value={aiReviewPrompt}
            onChange={(e) => setAIReviewPrompt(e.target.value)}
            placeholder="Focus on specific areas... (optional)"
          />
          <ToolModelSelector
            tools={tools}
            selectedTool={aiReviewTool}
            selectedModel={aiReviewModel}
            models={aiReviewModels}
            modelsFetching={aiReviewModelsFetching}
            onToolChange={(tool) => {
              setAIReviewTool(tool)
              setAIReviewModel('')
            }}
            onModelChange={setAIReviewModel}
            controlClass={controlClass}
            toolPlaceholder="- phase/default tool"
            modelPlaceholder="- default model"
          />
          <div className="flex justify-end gap-2">
            <ActionButton
              variant="default"
              onClick={handleAIReview}
              disabled={aiReviewing}
            >
              {aiReviewing ? 'Starting…' : 'Start Review'}
            </ActionButton>
            <ActionButton
              variant="default"
              onClick={() => setAIReviewExpanded(false)}
              disabled={aiReviewing}
            >
              Cancel
            </ActionButton>
          </div>
        </div>
      )}

      {reviewActionError && (
        <div className="text-xs text-[var(--status-failed)]">{reviewActionError}</div>
      )}
    </div>
  )
}
