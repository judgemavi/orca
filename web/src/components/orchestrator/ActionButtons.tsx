import { useState } from 'react'
import { Button } from '../Button'
import type { DetectedAction } from '../../lib/orchestratorActions'
import type { PhaseAction } from '../../lib/orchestratorPhaseActions'

interface Props {
  action?: DetectedAction | null
  phaseActions?: PhaseAction[] | null
  onAction: (response: string) => void | Promise<void>
  disabled?: boolean
  messageId?: string
}

interface RenderableAction {
  key: string
  label: string
  response: string
  variant: 'default' | 'primary' | 'destructive'
  needsInput?: boolean
  inputPlaceholder?: string
}

export function ActionButtons({
  action,
  phaseActions,
  onAction,
  disabled = false,
  messageId,
}: Props) {
  const resolvedActions: RenderableAction[] =
    phaseActions && phaseActions.length > 0
      ? phaseActions.map((phaseAction) => ({
          key: phaseAction.key,
          label: phaseAction.label,
          response: phaseAction.response,
          variant: phaseAction.variant,
          needsInput: phaseAction.needsInput,
          inputPlaceholder: phaseAction.inputPlaceholder,
        }))
      : action
        ? action.labels.map((label, index) => ({
            key: `${action.type}-${index}`,
            label,
            response: action.responses[index],
            variant: index === 0 ? 'primary' : 'default',
          }))
        : []

  const [pendingInputAction, setPendingInputAction] =
    useState<RenderableAction | null>(null)
  const [pendingInputText, setPendingInputText] = useState('')
  const [selectedResponse, setSelectedResponse] = useState<string | null>(null)
  const [selectedActionKey, setSelectedActionKey] = useState<string | null>(
    null,
  )
  if (resolvedActions.length === 0) return null

  const actionKey = `${messageId ?? ''}:${resolvedActions
    .map((candidate) => `${candidate.key}:${candidate.response}`)
    .join('|')}`
  const activeSelection =
    selectedActionKey === actionKey ? selectedResponse : null
  const isLocked = disabled || activeSelection !== null

  const submitResponse = (response: string) => {
    if (isLocked) return
    setSelectedActionKey(actionKey)
    setSelectedResponse(response)
    void onAction(response)
  }

  const handleClick = (nextAction: RenderableAction) => {
    if (isLocked) return
    if (nextAction.needsInput) {
      setPendingInputAction(nextAction)
      setPendingInputText('')
      return
    }
    submitResponse(nextAction.response)
  }

  const handleSubmitInput = () => {
    if (!pendingInputAction) return
    const feedback = pendingInputText.trim()
    if (!feedback) return
    const response = `${pendingInputAction.response}: ${feedback}`
    setPendingInputAction(null)
    setPendingInputText('')
    submitResponse(response)
  }

  const handleCancelInput = () => {
    setPendingInputAction(null)
    setPendingInputText('')
  }

  return (
    <div className="mt-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {resolvedActions.map((candidate) => {
          const isSelected = activeSelection === candidate.response
          return (
            <Button
              key={candidate.key}
              variant={candidate.variant}
              disabled={isLocked}
              aria-pressed={isSelected}
              className={
                isSelected
                  ? 'ring-2 ring-accent/30'
                  : undefined
              }
              onClick={() => handleClick(candidate)}
            >
              {candidate.label}
              {isSelected ? ' (selected)' : ''}
            </Button>
          )
        })}
      </div>

      {pendingInputAction ? (
        <div className="rounded-md border border-border-subtle bg-surface p-2">
          <div className="mb-2 text-xs text-muted">
            {pendingInputAction.label}
          </div>
          <textarea
            value={pendingInputText}
            onChange={(event) => setPendingInputText(event.target.value)}
            className="min-h-20 w-full resize-y rounded-md border border-border-subtle bg-surface-alt px-2 py-1.5 text-xs outline-none focus:border-accent"
            placeholder={
              pendingInputAction.inputPlaceholder ?? 'Add details...'
            }
            disabled={isLocked}
          />
          <div className="mt-2 flex items-center gap-2">
            <Button
              variant="primary"
              disabled={isLocked || !pendingInputText.trim()}
              onClick={handleSubmitInput}
            >
              Send
            </Button>
            <Button
              variant="default"
              disabled={isLocked}
              onClick={handleCancelInput}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
