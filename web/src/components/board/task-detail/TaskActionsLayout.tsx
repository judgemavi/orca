import { type ReactNode } from 'react'
import { controlClass } from '../../../lib/constants'
import { ToolModelSelector } from '../../common/ToolModelSelector'

type ToolModelOption = {
  id: string
  name: string
}

type Props = {
  tools: string[]
  actionTool: string
  actionModel: string
  actionModels: ToolModelOption[]
  actionModelsFetching: boolean
  onToolChange: (tool: string) => void
  onModelChange: (model: string) => void
  showToolModelSelector?: boolean
  actionError?: string | null
  feedback?: ReactNode
  actions: ReactNode
}

export function TaskActionsLayout({
  tools,
  actionTool,
  actionModel,
  actionModels,
  actionModelsFetching,
  onToolChange,
  onModelChange,
  showToolModelSelector = false,
  actionError,
  feedback,
  actions,
}: Props) {
  return (
    <div className="sticky bottom-0 z-20 border-t border-border-subtle bg-surface-elevated/95 px-4 py-3 backdrop-blur-sm shadow-[0_-4px_12px_rgba(0,0,0,0.1)]">
      {feedback}
      {actionError && <div className="mb-2 text-xs">{actionError}</div>}

      <div className="flex flex-wrap items-center justify-end gap-2">
        {showToolModelSelector && (
          <div className="mr-auto w-full min-w-[18rem] grow basis-full sm:basis-auto sm:max-w-[30rem]">
            <ToolModelSelector
              tools={tools}
              selectedTool={actionTool}
              selectedModel={actionModel}
              models={actionModels}
              modelsFetching={actionModelsFetching}
              onToolChange={onToolChange}
              onModelChange={onModelChange}
              controlClass={controlClass}
              toolPlaceholder="- phase/default tool"
              modelPlaceholder="- default model"
              className="grid grid-cols-1 gap-2 sm:grid-cols-2"
            />
          </div>
        )}

        {actions}
      </div>
    </div>
  )
}

type FeedbackProps = {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  showNotice?: boolean
}

export function TaskFeedbackBox({
  value,
  onChange,
  placeholder = 'Describe what needs to be changed...',
  showNotice = false,
}: FeedbackProps) {
  return (
    <div className="mb-3 flex flex-col gap-2 rounded-lg border border-border-subtle bg-surface px-3 py-3">
      {showNotice && (
        <div className="text-[11px] text-muted">AI review feedback applied</div>
      )}
      <textarea
        id="request-changes-feedback"
        className="w-full resize-y rounded-md border border-border-subtle bg-surface px-2.5 py-2 text-[13px] outline-none focus:border-accent"
        rows={3}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
    </div>
  )
}
