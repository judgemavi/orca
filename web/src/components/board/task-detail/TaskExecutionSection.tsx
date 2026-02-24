import { useEffect, useState } from 'react'
import { DiffViewer } from '../../blocks/DiffViewer'
import { ActionButton } from '../../common/ActionButton'
import { ToolModelSelector } from '../../common/ToolModelSelector'
import type { AIReviewResult, Interaction, Task, TaskReview } from '../../../types'
import { InteractionEntry } from './InteractionEntry'
import { InlineReviewActions } from './InlineReviewActions'

function formatRelativeTime(iso: string): string {
  const timestamp = Date.parse(iso)
  if (!Number.isFinite(timestamp)) return 'just now'
  const deltaSeconds = Math.round((timestamp - Date.now()) / 1000)
  const absDeltaSeconds = Math.abs(deltaSeconds)
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  if (absDeltaSeconds < 60) return rtf.format(deltaSeconds, 'second')
  if (absDeltaSeconds < 3600)
    return rtf.format(Math.round(deltaSeconds / 60), 'minute')
  if (absDeltaSeconds < 86400)
    return rtf.format(Math.round(deltaSeconds / 3600), 'hour')
  return rtf.format(Math.round(deltaSeconds / 86400), 'day')
}

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

                {isLatestCompleted &&
                  task.status === 'review' &&
                  !readOnly &&
                  !hasRunningExecution && (
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
                )}

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

                {item.status === 'completed' && itemReviews.length > 0 && (
                  <div className="flex flex-col gap-1.5">
                    {itemReviews.map((review) => (
                      <div
                        key={review.id}
                        className={[
                          'rounded-md border p-2.5',
                          review.status === 'pending'
                            ? 'border-amber-500/40 bg-amber-500/10'
                            : 'border-emerald-500/35 bg-emerald-500/10 opacity-80',
                        ].join(' ')}
                      >
                        <div className="mb-1 flex items-center justify-between gap-2">
                          <span className="text-[10px] font-semibold uppercase tracking-[0.05em] text-[var(--text-secondary)]">
                            {review.status}
                          </span>
                          <span className="text-[11px] text-[var(--text-secondary)]">
                            {formatRelativeTime(review.created_at)}
                          </span>
                        </div>
                        <div className="whitespace-pre-wrap text-xs text-[var(--text-primary)]">
                          {review.feedback}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </InteractionEntry>
            )
          })}

          {reviewInteractions.length > 0 && (
            <div className="flex flex-col gap-2 mt-2">
              {reviewInteractions.map((item) => (
                <InteractionEntry
                  key={item.id}
                  interaction={item}
                  activeLogId={activeLogId}
                  onToggleLog={onToggleLog}
                >
                  {item.status === 'completed' && item.quality_json && (
                    <AIReviewResultCard qualityJson={item.quality_json} />
                  )}
                </InteractionEntry>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function AIReviewResultCard({ qualityJson }: { qualityJson: string }) {
  try {
    const result: AIReviewResult = JSON.parse(qualityJson)
    return (
      <div
        className={[
          'rounded-md border p-2.5',
          result.approved
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
              result.approved ? 'text-emerald-400' : 'text-amber-400',
            ].join(' ')}
          >
            {result.approved ? 'Approved' : 'Changes Suggested'}
          </span>
        </div>
        <div className="whitespace-pre-wrap text-xs text-[var(--text-primary)]">
          {result.feedback}
        </div>
      </div>
    )
  } catch {
    return null
  }
}
