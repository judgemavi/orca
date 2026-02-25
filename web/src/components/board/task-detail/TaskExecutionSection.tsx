import { useEffect, useMemo, useState } from 'react'
import { DiffViewer } from '../../blocks/DiffViewer'
import { ActionButton } from '../../common/ActionButton'
import { ToolModelSelector } from '../../common/ToolModelSelector'
import type { AIReviewResult, Interaction, Task, TaskReview } from '../../../types'
import { InteractionEntry } from './InteractionEntry'
import { InlineReviewActions } from './InlineReviewActions'

function FailedRunActions({
  tools,
  rerunTool,
  rerunModel,
  rerunModels,
  rerunModelsFetching,
  controlClass,
  rerunning,
  onRerun,
  onRerunToolChange,
  onRerunModelChange,
}: {
  tools: string[]
  rerunTool: string
  rerunModel: string
  rerunModels: Array<{ id: string; name: string }>
  rerunModelsFetching: boolean
  controlClass: string
  rerunning: boolean
  onRerun: () => void
  onRerunToolChange: (value: string) => void
  onRerunModelChange: (value: string) => void
}) {
  return (
    <div className="flex flex-col gap-2.5 rounded-md border border-[var(--status-failed)]/30 bg-[var(--status-failed)]/10 p-3">
      <div className="text-xs text-[var(--text-primary)]">
        Execution failed. Re-run this task to generate a new result.
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto]">
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
          className="contents"
        />
        <ActionButton variant="primary" onClick={onRerun} disabled={rerunning}>
          {rerunning ? 'Re-running…' : 'Re-run'}
        </ActionButton>
      </div>
    </div>
  )
}

interface Props {
  task: Task
  tools: string[]
  runTool: string
  runModel: string
  runModels: Array<{ id: string; name: string }>
  runModelsFetching: boolean
  runPending: boolean
  runInteractions: Interaction[]
  reviewInteractions: Interaction[]
  interactionsLoading: boolean
  activeLogId: string | null
  feedback: string
  approving: boolean
  requesting: boolean
  aiReviewExpanded: boolean
  aiReviewing: boolean
  aiReviewTool: string
  aiReviewModel: string
  aiReviewModels: Array<{ id: string; name: string }>
  aiReviewModelsFetching: boolean
  aiReviewPrompt: string
  rerunning: boolean
  reviewActionError: string | null
  reviews: TaskReview[]
  rerunTool: string
  rerunModel: string
  rerunModels: Array<{ id: string; name: string }>
  rerunModelsFetching: boolean
  controlClass: string
  readOnly?: boolean
  onToggleLog: (id: string) => void
  onFeedbackChange: (value: string) => void
  onApprove: () => void
  onRequestChanges: (interactionId?: string, tool?: string, model?: string) => void
  onAIReview: () => void
  onAIReviewToolChange: (value: string) => void
  onAIReviewModelChange: (value: string) => void
  onAIReviewPromptChange: (value: string) => void
  onExpandAIReview: () => void
  onCancelAIReview: () => void
  onRun: () => void
  onRerun: () => void
  onRunToolChange: (value: string) => void
  onRunModelChange: (value: string) => void
  onRerunToolChange: (value: string) => void
  onRerunModelChange: (value: string) => void
}

export function TaskExecutionSection({
  task,
  tools,
  runTool,
  runModel,
  runModels,
  runModelsFetching,
  runPending,
  runInteractions,
  reviewInteractions,
  interactionsLoading,
  activeLogId,
  feedback,
  approving,
  requesting,
  aiReviewExpanded,
  aiReviewing,
  aiReviewTool,
  aiReviewModel,
  aiReviewModels,
  aiReviewModelsFetching,
  aiReviewPrompt,
  rerunning,
  reviewActionError,
  reviews,
  rerunTool,
  rerunModel,
  rerunModels,
  rerunModelsFetching,
  controlClass,
  readOnly = false,
  onToggleLog,
  onFeedbackChange,
  onApprove,
  onRequestChanges,
  onAIReview,
  onAIReviewToolChange,
  onAIReviewModelChange,
  onAIReviewPromptChange,
  onExpandAIReview,
  onCancelAIReview,
  onRun,
  onRerun,
  onRunToolChange,
  onRunModelChange,
  onRerunToolChange,
  onRerunModelChange,
}: Props) {
  const [reviewExpanded, setReviewExpanded] = useState(false)
  const [expandedDiffs, setExpandedDiffs] = useState<Set<string>>(new Set())
  const [dismissedReviews, setDismissedReviews] = useState<Set<string>>(new Set())
  const hasRunningExecution = runInteractions.some((item) => item.status === 'running')
  const latestCompletedId =
    [...runInteractions].reverse().find((item) => item.status === 'completed')?.id ?? null
  const latestFailedId =
    [...runInteractions].reverse().find((item) => item.status === 'failed')?.id ?? null

  useEffect(() => {
    setReviewExpanded(false)
  }, [runInteractions.length])

  useEffect(() => {
    if (latestCompletedId) {
      setExpandedDiffs(new Set([latestCompletedId]))
      return
    }
    setExpandedDiffs(new Set())
  }, [latestCompletedId])

  function toggleDiff(id: string) {
    setExpandedDiffs((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  function getReviewsForRun(runId: string, runStartedAt: string): Interaction[] {
    const runIndex = runInteractions.findIndex((run) => run.id === runId)
    const nextRunStartedAt =
      runIndex < runInteractions.length - 1 ? runInteractions[runIndex + 1].started_at : null

    return reviewInteractions.filter((reviewInteraction) => {
      const reviewStart = Date.parse(reviewInteraction.started_at)
      const runStart = Date.parse(runStartedAt)
      if (!Number.isFinite(reviewStart) || !Number.isFinite(runStart)) return false
      if (reviewStart < runStart) return false
      if (nextRunStartedAt && reviewStart >= Date.parse(nextRunStartedAt)) return false
      return true
    })
  }

  // Detect latest non-approved AI review for the latest completed run
  const activeAISuggestion = useMemo(() => {
    if (!latestCompletedId) return null
    const latestCompleted = runInteractions.find((i) => i.id === latestCompletedId)
    if (!latestCompleted) return null

    const revs = getReviewsForRun(latestCompletedId, latestCompleted.started_at)
    for (let i = revs.length - 1; i >= 0; i--) {
      const ri = revs[i]
      if (ri.status !== 'completed' || !ri.quality_json) continue
      if (dismissedReviews.has(ri.id)) return null
      try {
        const result: AIReviewResult = JSON.parse(ri.quality_json)
        if (!result.approved) {
          return { interactionId: ri.id, feedback: result.feedback }
        }
      } catch {
        // ignore
      }
      return null
    }
    return null
  }, [latestCompletedId, runInteractions, reviewInteractions, dismissedReviews])

  return (
    <div className="flex flex-col gap-2.5 rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] p-3">
      {interactionsLoading && (
        <div className="text-xs text-[var(--text-secondary)]">Loading interactions...</div>
      )}

      {!interactionsLoading && runInteractions.length === 0 && (
        <>
          {task.status === 'planned' && !readOnly ? (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto]">
              <ToolModelSelector
                tools={tools}
                selectedTool={runTool}
                selectedModel={runModel}
                models={runModels}
                modelsFetching={runModelsFetching}
                onToolChange={onRunToolChange}
                onModelChange={onRunModelChange}
                controlClass={controlClass}
                toolPlaceholder="- phase/default tool"
                modelPlaceholder="- default model"
                className="contents"
              />
              <ActionButton variant="primary" onClick={onRun} disabled={runPending}>
                {runPending ? 'Running…' : 'Run'}
              </ActionButton>
            </div>
          ) : (
            <div className="text-xs text-[var(--text-secondary)]">
              No execution interactions found for this task yet.
            </div>
          )}
        </>
      )}

      {!interactionsLoading && runInteractions.length > 0 && (
        <div className="flex flex-col gap-2">
          {runInteractions.map((item) => {
            const isLatestCompleted =
              item.status === 'completed' && item.id === latestCompletedId
            const isLatestFailed = item.status === 'failed' && item.id === latestFailedId
            const itemReviews = reviews.filter((review) => review.interaction_id === item.id)
            const runReviewInteractions = getReviewsForRun(item.id, item.started_at)

            return (
              <InteractionEntry
                key={item.id}
                interaction={item}
                activeLogId={activeLogId}
                onToggleLog={onToggleLog}
              >
                {item.status === 'completed' && item.diff && (
                  <>
                    <button
                      type="button"
                      className="text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                      onClick={() => toggleDiff(item.id)}
                    >
                      {expandedDiffs.has(item.id) ? '▾ Hide diff' : '▸ Show diff'}
                    </button>
                    {expandedDiffs.has(item.id) && (
                      <DiffViewer
                        data={{
                          task_id: task.id,
                          title: task.title,
                          diff: item.diff,
                          files_changed: [],
                          actions: [],
                        }}
                      />
                    )}
                  </>
                )}

                {runReviewInteractions.length > 0 && (
                  <div className="flex flex-col gap-1.5">
                    {runReviewInteractions.map((reviewInteraction) => (
                      <AIReviewResultCard
                        key={reviewInteraction.id}
                        interaction={reviewInteraction}
                        dismissed={dismissedReviews.has(reviewInteraction.id)}
                        activeLogId={activeLogId}
                        onToggleLog={onToggleLog}
                      />
                    ))}
                  </div>
                )}

                {item.status === 'completed' && itemReviews.length > 0 && (
                  <div className="flex flex-col gap-1.5">
                    {itemReviews.map((review) => (
                      <div
                        key={review.id}
                        className={[
                          'rounded-md border p-2.5',
                          review.status === 'pending'
                            ? 'border-amber-500/40 bg-amber-500/10'
                            : 'border-emerald-500/35 bg-emerald-500/10',
                        ].join(' ')}
                      >
                        <div className="mb-1 flex items-center gap-2">
                          <span className="text-[10px] font-semibold uppercase tracking-[0.05em] text-[var(--text-secondary)]">
                            Request Changes
                          </span>
                          <span
                            className={[
                              'text-[10px] font-semibold uppercase',
                              review.status === 'pending' ? 'text-amber-400' : 'text-emerald-400',
                            ].join(' ')}
                          >
                            {review.status === 'pending' ? 'Pending' : 'Addressed'}
                          </span>
                        </div>
                        <div className="whitespace-pre-wrap text-xs text-[var(--text-primary)]">
                          {review.feedback}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {isLatestCompleted &&
                  task.status === 'review' &&
                  !readOnly &&
                  !hasRunningExecution &&
                  (activeAISuggestion && !reviewExpanded ? (
                    <div className="flex flex-col gap-2.5">
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        <ActionButton
                          variant="primary"
                          onClick={() => {
                            onFeedbackChange(activeAISuggestion.feedback)
                            setReviewExpanded(true)
                            onCancelAIReview()
                          }}
                          disabled={requesting}
                        >
                          Request Changes
                        </ActionButton>
                        <ActionButton
                          variant="default"
                          onClick={() => {
                            setDismissedReviews((prev) => new Set([...prev, activeAISuggestion.interactionId]))
                            onFeedbackChange('')
                          }}
                        >
                          Dismiss
                        </ActionButton>
                      </div>
                      {reviewActionError && (
                        <div className="text-xs text-[var(--status-failed)]">{reviewActionError}</div>
                      )}
                    </div>
                  ) : (
                    <InlineReviewActions
                      interactionId={item.id}
                      feedback={feedback}
                      reviewExpanded={reviewExpanded}
                      aiReviewExpanded={aiReviewExpanded}
                      approving={approving}
                      requesting={requesting}
                      aiReviewing={aiReviewing}
                      reviewActionError={reviewActionError}
                      tools={tools}
                      rerunTool={rerunTool}
                      rerunModel={rerunModel}
                      rerunModels={rerunModels}
                      rerunModelsFetching={rerunModelsFetching}
                      aiReviewTool={aiReviewTool}
                      aiReviewModel={aiReviewModel}
                      aiReviewModels={aiReviewModels}
                      aiReviewModelsFetching={aiReviewModelsFetching}
                      aiReviewPrompt={aiReviewPrompt}
                      controlClass={controlClass}
                      onFeedbackChange={onFeedbackChange}
                      onExpandRequestChanges={() => {
                        setReviewExpanded(true)
                        onCancelAIReview()
                      }}
                      onCancelRequestChanges={() => setReviewExpanded(false)}
                      onAIReview={onAIReview}
                      onAIReviewToolChange={onAIReviewToolChange}
                      onAIReviewModelChange={onAIReviewModelChange}
                      onAIReviewPromptChange={onAIReviewPromptChange}
                      onExpandAIReview={() => {
                        setReviewExpanded(false)
                        onExpandAIReview()
                      }}
                      onCancelAIReview={onCancelAIReview}
                      onApprove={onApprove}
                      onRequestChanges={onRequestChanges}
                      onRerunToolChange={onRerunToolChange}
                      onRerunModelChange={onRerunModelChange}
                    />
                  ))}

                {isLatestFailed && !readOnly && (
                  <FailedRunActions
                    tools={tools}
                    rerunTool={rerunTool}
                    rerunModel={rerunModel}
                    rerunModels={rerunModels}
                    rerunModelsFetching={rerunModelsFetching}
                    controlClass={controlClass}
                    rerunning={rerunning}
                    onRerun={onRerun}
                    onRerunToolChange={onRerunToolChange}
                    onRerunModelChange={onRerunModelChange}
                  />
                )}
              </InteractionEntry>
            )
          })}
        </div>
      )}
    </div>
  )
}

function AIReviewResultCard({
  interaction: ri,
  dismissed,
  activeLogId,
  onToggleLog,
}: {
  interaction: Interaction
  dismissed?: boolean
  activeLogId?: string | null
  onToggleLog?: (id: string) => void
}) {
  const logButton = onToggleLog ? (
    <button
      type="button"
      className={[
        'ml-auto text-[10px]',
        activeLogId === ri.id
          ? 'text-[var(--accent)]'
          : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
      ].join(' ')}
      onClick={() => onToggleLog(ri.id)}
    >
      log
    </button>
  ) : null
  if (ri.status === 'running') {
    return (
      <div className="rounded-md border border-[var(--border)] bg-[var(--bg-primary)] p-2.5">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-[0.05em] text-[var(--text-secondary)]">
            AI Review
          </span>
          <span className="text-[10px] font-semibold uppercase text-[var(--text-secondary)]">
            Running…
          </span>
          {ri.tool && (
            <span className="text-[10px] text-[var(--text-secondary)]">{ri.tool}</span>
          )}
          {logButton}
        </div>
      </div>
    )
  }

  if (ri.status === 'failed') {
    return (
      <div className="rounded-md border border-[var(--status-failed)]/30 bg-[var(--status-failed)]/10 p-2.5">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-[0.05em] text-[var(--text-secondary)]">
            AI Review
          </span>
          <span className="text-[10px] font-semibold uppercase text-[var(--status-failed)]">
            Failed
          </span>
          {logButton}
        </div>
        {ri.error && (
          <div className="mt-1 whitespace-pre-wrap text-xs text-[var(--text-primary)]">
            {ri.error}
          </div>
        )}
      </div>
    )
  }

  if (!ri.quality_json) return null

  try {
    const result: AIReviewResult = JSON.parse(ri.quality_json)
    const costLabel = [
      ri.tool,
      ri.estimated_cost > 0 ? `$${ri.estimated_cost.toFixed(2)}` : null,
    ].filter(Boolean).join(' · ')

    const isDismissed = dismissed && !result.approved

    return (
      <div
        className={[
          'rounded-md border p-2.5',
          isDismissed
            ? 'border-[var(--border)] bg-[var(--bg-primary)] opacity-60'
            : result.approved
              ? 'border-emerald-500/35 bg-emerald-500/10'
              : 'border-amber-500/40 bg-amber-500/10',
        ].join(' ')}
      >
        <div className="mb-1 flex items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-[0.05em] text-[var(--text-secondary)]">
            AI Review
          </span>
          <span
            className={[
              'text-[10px] font-semibold uppercase',
              isDismissed
                ? 'text-[var(--text-secondary)]'
                : result.approved ? 'text-emerald-400' : 'text-amber-400',
            ].join(' ')}
          >
            {isDismissed ? 'Dismissed' : result.approved ? 'Approved' : 'Changes Suggested'}
          </span>
          {costLabel && (
            <span className="text-[10px] text-[var(--text-secondary)]">{costLabel}</span>
          )}
          {logButton}
        </div>
        {result.prompt && (
          <div className="mb-1.5 rounded border border-[var(--border)] bg-[var(--bg-primary)] px-2 py-1.5 text-[11px] italic text-[var(--text-secondary)]">
            {result.prompt}
          </div>
        )}
        <div className="whitespace-pre-wrap text-xs text-[var(--text-primary)]">
          {result.feedback}
        </div>
      </div>
    )
  } catch {
    return null
  }
}
