import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ActionButton } from '../../common/ActionButton'

interface Props {
  isEditable: boolean
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
  onStartEdit: () => void
  onPlanDraftChange: (value: string) => void
  onCancelEdit: () => void
  onSavePlan: () => void
  onRegeneratePlan: () => void
  onGenerateToolChange: (value: string) => void
  onGenerateModelChange: (value: string) => void
  onGeneratePlan: () => void
}

export function TaskPlanSection({
  isEditable,
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
  onStartEdit,
  onPlanDraftChange,
  onCancelEdit,
  onSavePlan,
  onRegeneratePlan,
  onGenerateToolChange,
  onGenerateModelChange,
  onGeneratePlan,
}: Props) {
  return (
    <div className="flex flex-col gap-2.5 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-[var(--text-secondary)]">Plan</span>
        {isEditable && (
          <div className="flex gap-2">
            {hasPlan && !planEditing && (
              <ActionButton variant="default" onClick={onStartEdit}>
                Edit
              </ActionButton>
            )}
            {hasPlan && (
              <ActionButton
                variant="default"
                onClick={onRegeneratePlan}
                disabled={planGenerating || generatePlanPending}
              >
                {planGenerating ? 'Regenerating…' : 'Regenerate'}
              </ActionButton>
            )}
          </div>
        )}
      </div>

      {isEditable && (
        <div className="grid grid-cols-1 items-center gap-2 sm:grid-cols-[1fr_1fr_auto]">
          <select
            className={controlClass}
            value={generateTool}
            onChange={(e) => onGenerateToolChange(e.target.value)}
          >
            <option value="">- task/default tool</option>
            {tools.filter(Boolean).map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>

          <select
            className={controlClass}
            value={generateModel}
            onChange={(e) => onGenerateModelChange(e.target.value)}
            disabled={!generateTool || generateModelsFetching}
          >
            <option value="">- default generation model</option>
            {generationModels.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name}
              </option>
            ))}
          </select>

          {!hasPlan && (
            <ActionButton
              variant="primary"
              onClick={onGeneratePlan}
              disabled={planGenerating || planLoading || generatePlanPending}
            >
              {planGenerating ? 'Generating…' : 'Generate Plan'}
            </ActionButton>
          )}
        </div>
      )}

      {planLoading && <div className="text-xs text-[var(--text-secondary)]">Loading plan...</div>}
      {!planLoading && !hasPlan && (
        <div className="text-xs text-[var(--text-secondary)]">No plan saved yet.</div>
      )}

      {!planLoading && hasPlan && !planEditing && (
        <div className="prose prose-invert prose-sm max-w-none max-h-[300px] overflow-auto rounded-md border border-[var(--border)] bg-[var(--bg-primary)] p-2.5 text-xs text-[var(--text-primary)]">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{plan ?? ''}</ReactMarkdown>
        </div>
      )}

      {!planLoading && hasPlan && planEditing && isEditable && (
        <>
          <textarea
            className="w-full resize-y rounded-md border border-[var(--border)] bg-[var(--bg-primary)] p-2.5 font-mono text-xs leading-[1.45] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
            value={planDraft}
            onChange={(e) => onPlanDraftChange(e.target.value)}
            rows={12}
          />
          <div className="flex justify-end gap-2">
            <ActionButton variant="default" onClick={onCancelEdit}>
              Cancel
            </ActionButton>
            <ActionButton variant="primary" onClick={onSavePlan} disabled={planSaving}>
              {planSaving ? 'Saving…' : 'Save'}
            </ActionButton>
          </div>
        </>
      )}

      {planError && <div className="text-xs text-[var(--status-failed)]">{planError}</div>}
    </div>
  )
}
