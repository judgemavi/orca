import { useEffect, useMemo, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { api } from '../../../api'
import { useTaskDetailContext } from '../../../context/TaskDetailContext'
import { useModelsQuery } from '../../../hooks/queries/useModels'
import { controlClass } from '../../../lib/constants'
import { getErrorMessage } from '../../../lib/utils'
import { ActionButton } from '../../common/ActionButton'
import { ToolModelSelector } from '../../common/ToolModelSelector'
import { selectByPhase, useInteractionsQuery } from './useInteractions'

type Props = {
  forceReviewExpanded?: boolean
  prefillFeedback?: string
}

export function InlineReviewActions({
  forceReviewExpanded = false,
  prefillFeedback = '',
}: Props) {
  const { task, tools, activeLogId } = useTaskDetailContext()
  void activeLogId

  const approveMutation = useMutation({ mutationFn: (taskId: string) => api.approveTask(taskId) })
  const requestChangesMutation = useMutation({
    mutationFn: (args: { id: string; feedback: string; interactionId?: string; tool?: string; model?: string }) =>
      api.requestChanges(args.id, args.feedback, args.interactionId, args.tool, args.model),
  })
  const aiReviewMutation = useMutation({
    mutationFn: (args: { taskId: string; tool?: string; model?: string; prompt?: string }) =>
      api.aiReview(args.taskId, args.tool, args.model, args.prompt),
  })
  const runInteractions = useInteractionsQuery(task.id, {
    select: selectByPhase('run'),
  })

  const [feedback, setFeedback] = useState('')
  const [reviewExpanded, setReviewExpanded] = useState(false)
  const [aiReviewExpanded, setAIReviewExpanded] = useState(false)
  const [aiReviewPrompt, setAIReviewPrompt] = useState('')
  const [rerunTool, setRerunTool] = useState('')
  const [rerunModel, setRerunModel] = useState('')
  const [aiReviewTool, setAIReviewTool] = useState('')
  const [aiReviewModel, setAIReviewModel] = useState('')
  const [reviewActionError, setReviewActionError] = useState<string | null>(
    null,
  )

  const rerunModelsQuery = useModelsQuery(rerunTool || undefined)
  const aiReviewModelsQuery = useModelsQuery(aiReviewTool || undefined)

  const rerunModels = rerunTool
    ? (rerunModelsQuery.data?.[rerunTool] ?? [])
    : []
  const aiReviewModels = aiReviewTool
    ? (aiReviewModelsQuery.data?.[aiReviewTool] ?? [])
    : []

  const approving = approveMutation.isPending
  const requesting = requestChangesMutation.isPending
  const aiReviewing = aiReviewMutation.isPending

  const interactionId = useMemo(
    () =>
      [...(runInteractions.data ?? [])]
        .reverse()
        .find((item) => item.status === 'completed')?.id,
    [runInteractions.data],
  )

  useEffect(() => {
    if (!forceReviewExpanded) return
    setAIReviewExpanded(false)
    setReviewExpanded(true)
    setFeedback((prev) => prev || prefillFeedback)
  }, [forceReviewExpanded, prefillFeedback])

  const handleApprove = async () => {
    setReviewActionError(null)
    try {
      await approveMutation.mutateAsync(task.id)
    } catch (err: unknown) {
      setReviewActionError(getErrorMessage(err, 'Approve failed'))
    }
  }

  const handleRequestChanges = async () => {
    const trimmedFeedback = feedback.trim()
    if (!trimmedFeedback) {
      setReviewActionError('Feedback is required')
      return
    }

    setReviewActionError(null)
    try {
      await requestChangesMutation.mutateAsync({
        id: task.id,
        feedback: trimmedFeedback,
        interactionId,
        tool: rerunTool || undefined,
        model: rerunModel || undefined,
      })
    } catch (err: unknown) {
      setReviewActionError(getErrorMessage(err, 'Request changes failed'))
    }
  }

  const handleAIReview = async () => {
    setReviewActionError(null)
    try {
      await aiReviewMutation.mutateAsync({
        taskId: task.id,
        tool: aiReviewTool || undefined,
        model: aiReviewModel || undefined,
        prompt: aiReviewPrompt.trim() || undefined,
      })
    } catch (err: unknown) {
      setReviewActionError(getErrorMessage(err, 'AI review failed'))
    }
  }

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {!reviewExpanded && !aiReviewExpanded && (
          <ActionButton
            variant="primary"
            onClick={handleApprove}
            disabled={approving || requesting}
          >
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
            className="w-full resize-y rounded-md border p-2 text-[13px] outline-none focus:border-accent"
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
            modelsFetching={rerunModelsQuery.isFetching}
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
              onClick={handleRequestChanges}
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
            className="w-full resize-y rounded-md border p-2 text-[13px] outline-none focus:border-accent"
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
            modelsFetching={aiReviewModelsQuery.isFetching}
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

      {reviewActionError && <div className="text-xs">{reviewActionError}</div>}
    </div>
  )
}
