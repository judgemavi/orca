import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { api } from '../../../api'
import { useTaskDetailContext } from '../../../context/TaskDetailContext'
import { useModelsQuery } from '../../../hooks/queries/useModels'
import { controlClass } from '../../../lib/constants'
import { getErrorMessage } from '../../../lib/utils'
import type { useTaskForm } from '../../../hooks/forms/useTaskForm'
import { ActionButton } from '../../common/ActionButton'
import { ToolModelSelector } from '../../common/ToolModelSelector'
import { selectByPhase, useInteractionsQuery } from './useInteractions'

interface Props {
  isEditable: boolean
  isDeletable: boolean
  deleting: boolean
  saving: boolean
  formId: string
  form: ReturnType<typeof useTaskForm>
  onDelete: () => void
  onClose: () => void
}

const STATUS_WITH_OPTIONS = new Set(['planned', 'review', 'approved', 'failed'])

export function TaskActionsBar({
  isEditable,
  isDeletable,
  deleting,
  saving,
  formId,
  form,
  onDelete,
  onClose,
}: Props) {
  const { task, tools, isOperationRunning } = useTaskDetailContext()
  const runInteractionsQuery = useInteractionsQuery(task.id, {
    select: selectByPhase('run'),
  })

  const runTaskMutation = useMutation({
    mutationFn: (args: { taskId: string; tool?: string; model?: string }) =>
      api.runTasks([args.taskId], args.tool, args.model),
  })
  const approveMutation = useMutation({ mutationFn: (taskId: string) => api.approveTask(taskId) })
  const requestChangesMutation = useMutation({
    mutationFn: (args: { id: string; feedback: string; interactionId?: string; tool?: string; model?: string }) =>
      api.requestChanges(args.id, args.feedback, args.interactionId, args.tool, args.model),
  })
  const aiReviewMutation = useMutation({
    mutationFn: (args: { taskId: string; tool?: string; model?: string }) =>
      api.aiReview(args.taskId, args.tool, args.model),
  })
  const mergeTaskMutation = useMutation({
    mutationFn: (args: { taskId: string; tool?: string; model?: string }) =>
      api.mergeTask(args.taskId, undefined, args.tool, args.model),
  })

  const [requestChangesExpanded, setRequestChangesExpanded] = useState(false)
  const [requestFeedback, setRequestFeedback] = useState('')
  const [actionTool, setActionTool] = useState('')
  const [actionModel, setActionModel] = useState('')
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const optionsRef = useRef<HTMLDivElement | null>(null)

  const actionModelsQuery = useModelsQuery(actionTool || undefined)
  const actionModels = actionTool ? (actionModelsQuery.data?.[actionTool] ?? []) : []
  const runInteractions = runInteractionsQuery.data ?? []

  const latestCompletedRunId = useMemo(
    () => [...runInteractions].reverse().find((item) => item.status === 'completed')?.id,
    [runInteractions],
  )

  const runningInProgress = task.status === 'running' || isOperationRunning('run', task.id)
  const runningBusy = runningInProgress || runTaskMutation.isPending

  useEffect(() => {
    setRequestChangesExpanded(false)
    setRequestFeedback('')
    setOptionsOpen(false)
    setActionError(null)
  }, [task.id, task.status])

  useEffect(() => {
    if (!optionsOpen) return
    const onPointerDown = (event: MouseEvent) => {
      if (!optionsRef.current?.contains(event.target as Node)) {
        setOptionsOpen(false)
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [optionsOpen])

  const handleRun = async () => {
    setActionError(null)
    try {
      await runTaskMutation.mutateAsync({
        taskId: task.id,
        tool: actionTool || undefined,
        model: actionModel || undefined,
      })
    } catch (err: unknown) {
      setActionError(getErrorMessage(err, 'Run failed'))
    }
  }

  const handleApprove = async () => {
    setActionError(null)
    try {
      await approveMutation.mutateAsync(task.id)
    } catch (err: unknown) {
      setActionError(getErrorMessage(err, 'Approve failed'))
    }
  }

  const handleRequestChanges = async () => {
    const trimmedFeedback = requestFeedback.trim()
    if (!trimmedFeedback) {
      setActionError('Feedback is required')
      return
    }

    setActionError(null)
    try {
      await requestChangesMutation.mutateAsync({
        id: task.id,
        feedback: trimmedFeedback,
        interactionId: latestCompletedRunId,
        tool: actionTool || undefined,
        model: actionModel || undefined,
      })
      setRequestChangesExpanded(false)
      setRequestFeedback('')
    } catch (err: unknown) {
      setActionError(getErrorMessage(err, 'Request changes failed'))
    }
  }

  const handleAIReview = async () => {
    setActionError(null)
    try {
      await aiReviewMutation.mutateAsync({
        taskId: task.id,
        tool: actionTool || undefined,
        model: actionModel || undefined,
      })
    } catch (err: unknown) {
      setActionError(getErrorMessage(err, 'AI review failed'))
    }
  }

  const handleMerge = async () => {
    setActionError(null)
    try {
      await mergeTaskMutation.mutateAsync({
        taskId: task.id,
        tool: actionTool || undefined,
        model: actionModel || undefined,
      })
    } catch (err: unknown) {
      setActionError(getErrorMessage(err, 'Merge failed'))
    }
  }

  const renderStatusActions = () => {
    if (task.status === 'pending') {
      return (
        <>
          {isDeletable && (
            <ActionButton variant="danger" onClick={onDelete} disabled={deleting}>
              {deleting ? 'Deleting…' : 'Delete'}
            </ActionButton>
          )}
          {isEditable && (
            <form.Subscribe selector={(state) => state.isDirty}>
              {(isDirty) => (
                <ActionButton
                  variant="primary"
                  type="submit"
                  form={formId}
                  disabled={saving || !isDirty}
                >
                  {saving ? 'Saving…' : 'Save'}
                </ActionButton>
              )}
            </form.Subscribe>
          )}
        </>
      )
    }

    if (task.status === 'planned') {
      return (
        <ActionButton variant="primary" onClick={handleRun} disabled={runningBusy}>
          {runningBusy ? 'Running…' : 'Run'}
        </ActionButton>
      )
    }

    if (task.status === 'running') {
      return (
        <ActionButton variant="primary" disabled>
          <span className="mr-1.5 inline-block h-3 w-3 animate-spin rounded-full border border-current border-t-transparent" />
          Running…
        </ActionButton>
      )
    }

    if (task.status === 'review') {
      if (requestChangesExpanded) {
        return (
          <>
            <ActionButton
              variant="default"
              onClick={() => {
                setRequestChangesExpanded(false)
                setActionError(null)
              }}
              disabled={requestChangesMutation.isPending}
            >
              Cancel
            </ActionButton>
            <ActionButton
              variant="primary"
              onClick={handleRequestChanges}
              disabled={requestChangesMutation.isPending}
            >
              {requestChangesMutation.isPending ? 'Submitting…' : 'Submit Request Changes'}
            </ActionButton>
          </>
        )
      }

      return (
        <>
          <ActionButton
            variant="primary"
            onClick={handleApprove}
            disabled={approveMutation.isPending || requestChangesMutation.isPending}
          >
            {approveMutation.isPending ? 'Approving…' : 'Approve'}
          </ActionButton>
          <ActionButton
            variant="default"
            onClick={() => {
              setRequestChangesExpanded(true)
              setActionError(null)
            }}
            disabled={approveMutation.isPending || requestChangesMutation.isPending}
          >
            Request Changes
          </ActionButton>
          <ActionButton
            variant="default"
            onClick={handleAIReview}
            disabled={aiReviewMutation.isPending || approveMutation.isPending}
          >
            {aiReviewMutation.isPending ? 'Reviewing…' : 'AI Review'}
          </ActionButton>
        </>
      )
    }

    if (task.status === 'approved') {
      return (
        <ActionButton
          variant="primary"
          onClick={handleMerge}
          disabled={mergeTaskMutation.isPending || isOperationRunning('merge', task.id)}
        >
          {mergeTaskMutation.isPending || isOperationRunning('merge', task.id)
            ? 'Merging…'
            : 'Merge'}
        </ActionButton>
      )
    }

    if (task.status === 'failed') {
      return (
        <>
          {isDeletable && (
            <ActionButton variant="danger" onClick={onDelete} disabled={deleting}>
              {deleting ? 'Deleting…' : 'Delete'}
            </ActionButton>
          )}
          <ActionButton variant="primary" onClick={handleRun} disabled={runningBusy}>
            {runningBusy ? 'Re-running…' : 'Re-run'}
          </ActionButton>
        </>
      )
    }

    if (task.status === 'merged') {
      return (
        <ActionButton variant="default" onClick={onClose} type="button">
          Close
        </ActionButton>
      )
    }

    return null
  }

  const showOptions = STATUS_WITH_OPTIONS.has(task.status)

  return (
    <div className="sticky bottom-0 z-20 border-t border-border-subtle bg-surface-elevated/95 px-4 py-3 backdrop-blur-sm shadow-[0_-4px_12px_rgba(0,0,0,0.1)]">
      {requestChangesExpanded && (
        <div className="mb-3 flex flex-col gap-2 rounded-lg border border-border-subtle bg-surface px-3 py-3">
          <textarea
            id="request-changes-feedback"
            className="w-full resize-y rounded-md border border-border-subtle bg-surface px-2.5 py-2 text-[13px] outline-none focus:border-accent"
            rows={3}
            value={requestFeedback}
            onChange={(event) => setRequestFeedback(event.target.value)}
            placeholder="Describe what needs to be changed..."
          />
        </div>
      )}

      {actionError && <div className="mb-2 text-xs">{actionError}</div>}

      <div className="flex flex-wrap items-center justify-end gap-2" ref={optionsRef}>
        {showOptions && (
          <div className="relative">
            <ActionButton
              variant="default"
              onClick={() => setOptionsOpen((prev) => !prev)}
              disabled={
                runTaskMutation.isPending ||
                requestChangesMutation.isPending ||
                aiReviewMutation.isPending ||
                mergeTaskMutation.isPending
              }
            >
              Options
            </ActionButton>

            {optionsOpen && (
              <div className="absolute bottom-[calc(100%+8px)] right-0 z-30 w-[min(30rem,calc(100vw-2rem))] rounded-lg border border-border-subtle bg-surface-elevated p-3 shadow-[0_8px_32px_rgba(0,0,0,0.3)]">
                <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted">
                  Tool / Model
                </div>
                <ToolModelSelector
                  tools={tools}
                  selectedTool={actionTool}
                  selectedModel={actionModel}
                  models={actionModels}
                  modelsFetching={actionModelsQuery.isFetching}
                  onToolChange={(tool) => {
                    setActionTool(tool)
                    setActionModel('')
                  }}
                  onModelChange={setActionModel}
                  controlClass={controlClass}
                  toolPlaceholder="- phase/default tool"
                  modelPlaceholder="- default model"
                />
              </div>
            )}
          </div>
        )}

        {renderStatusActions()}
      </div>
    </div>
  )
}
