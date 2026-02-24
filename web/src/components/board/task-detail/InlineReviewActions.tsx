import { ActionButton } from '../../common/ActionButton'
import { ToolModelSelector } from '../../common/ToolModelSelector'

interface Props {
  interactionId: string
  feedback: string
  reviewExpanded: boolean
  approving: boolean
  requesting: boolean
  reviewActionError: string | null
  tools: string[]
  rerunTool: string
  rerunModel: string
  rerunModels: Array<{ id: string; name: string }>
  rerunModelsFetching: boolean
  controlClass: string
  onFeedbackChange: (value: string) => void
  onExpandRequestChanges: () => void
  onCancelRequestChanges: () => void
  onApprove: () => void
  onRequestChanges: (interactionId?: string, tool?: string, model?: string) => void
  onRerunToolChange: (value: string) => void
  onRerunModelChange: (value: string) => void
}

export function InlineReviewActions({
  interactionId,
  feedback,
  reviewExpanded,
  approving,
  requesting,
  reviewActionError,
  tools,
  rerunTool,
  rerunModel,
  rerunModels,
  rerunModelsFetching,
  controlClass,
  onFeedbackChange,
  onExpandRequestChanges,
  onCancelRequestChanges,
  onApprove,
  onRequestChanges,
  onRerunToolChange,
  onRerunModelChange,
}: Props) {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <ActionButton variant="primary" onClick={onApprove} disabled={approving || requesting}>
          {approving ? 'Approving…' : 'Approve'}
        </ActionButton>
        {!reviewExpanded && (
          <ActionButton variant="default" onClick={onExpandRequestChanges} disabled={approving || requesting}>
            Request Changes
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
            onChange={(e) => onFeedbackChange(e.target.value)}
            placeholder="Describe what needs to be changed..."
          />
          <ToolModelSelector
            tools={tools}
            selectedTool={rerunTool}
            selectedModel={rerunModel}
            models={rerunModels}
            modelsFetching={rerunModelsFetching}
            onToolChange={onRerunToolChange}
            onModelChange={onRerunModelChange}
            controlClass={controlClass}
            toolPlaceholder="- phase/default tool"
            modelPlaceholder="- default model"
          />
          <div className="flex justify-end gap-2">
            <ActionButton
              variant="default"
              onClick={() =>
                onRequestChanges(interactionId, rerunTool || undefined, rerunModel || undefined)
              }
              disabled={requesting || approving}
            >
              {requesting ? 'Submitting…' : 'Submit Request Changes'}
            </ActionButton>
            <ActionButton variant="default" onClick={onCancelRequestChanges} disabled={requesting || approving}>
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
