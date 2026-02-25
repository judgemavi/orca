import * as Collapsible from '@radix-ui/react-collapsible'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTaskDetailContext } from '../../../context/TaskDetailContext'
import { useModelsQuery } from '../../../hooks/queries/useModels'
import { useTaskReviewsQuery } from '../../../hooks/queries/useReviews'
import { useRunTaskMutation } from '../../../hooks/queries/useTaskMutations'
import { controlClass } from '../../../lib/constants'
import type { AIReviewResult, Interaction } from '../../../types'
import { DiffViewer } from '../../blocks/DiffViewer'
import { ActionButton } from '../../common/ActionButton'
import { ToolModelSelector } from '../../common/ToolModelSelector'
import { AIReviewResultCard } from './AIReviewResultCard'
import { FailedRunActions } from './FailedRunActions'
import { InlineReviewActions } from './InlineReviewActions'
import { InteractionEntry } from './InteractionEntry'
import { selectByPhase, useInteractionsQuery } from './useInteractions'

interface Props {
  readOnly?: boolean
}

function getErrorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback
}

export function TaskExecutionSection({ readOnly = false }: Props) {
  const { task, tools, activeLogId, setActiveLogId, isOperationRunning, onSaved } =
    useTaskDetailContext()
  void isOperationRunning

  const runInteractionsQuery = useInteractionsQuery(task.id, {
    select: selectByPhase('run'),
  })
  const reviewInteractionsQuery = useInteractionsQuery(task.id, {
    select: selectByPhase('review'),
  })
  const reviewsQuery = useTaskReviewsQuery(task.id)
  const runTaskMutation = useRunTaskMutation()

  const [runTool, setRunTool] = useState('')
  const [runModel, setRunModel] = useState('')
  const [reviewExpanded, setReviewExpanded] = useState(false)
  const [expandedDiffs, setExpandedDiffs] = useState<Set<string>>(new Set())
  const [dismissedReviews, setDismissedReviews] = useState<Set<string>>(new Set())
  const [runError, setRunError] = useState<string | null>(null)

  const runModelsQuery = useModelsQuery(runTool || undefined)

  const runInteractions = runInteractionsQuery.data ?? []
  const reviewInteractions = reviewInteractionsQuery.data ?? []
  const runPending = runTaskMutation.isPending
  const runModels = runTool ? (runModelsQuery.data?.[runTool] ?? []) : []

  const runInteractionIDs = useMemo(
    () => new Set(runInteractions.map((item) => item.id)),
    [runInteractions],
  )
  const runReviews = useMemo(
    () =>
      (reviewsQuery.data?.reviews ?? []).filter(
        (review) =>
          Boolean(review.interaction_id) &&
          runInteractionIDs.has(review.interaction_id as string),
      ),
    [reviewsQuery.data?.reviews, runInteractionIDs],
  )

  const interactionsLoading =
    runInteractionsQuery.isLoading || reviewInteractionsQuery.isLoading

  const hasRunningExecution = runInteractions.some((item) => item.status === 'running')
  const latestCompletedId =
    [...runInteractions].reverse().find((item) => item.status === 'completed')?.id ?? null
  const latestFailedId =
    [...runInteractions].reverse().find((item) => item.status === 'failed')?.id ?? null

  useEffect(() => {
    if (latestCompletedId) {
      setExpandedDiffs(new Set([latestCompletedId]))
      return
    }
    setExpandedDiffs(new Set())
  }, [latestCompletedId])

  const handleRun = async () => {
    setRunError(null)
    try {
      await runTaskMutation.mutateAsync({
        taskId: task.id,
        tool: runTool || undefined,
        model: runModel || undefined,
      })
      onSaved()
    } catch (err: unknown) {
      setRunError(getErrorMessage(err, 'Run failed'))
    }
  }

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

  const getReviewsForRun = useCallback((runId: string, runStartedAt: string): Interaction[] => {
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
  }, [runInteractions, reviewInteractions])

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
  }, [latestCompletedId, runInteractions, dismissedReviews, getReviewsForRun])

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
                modelsFetching={runModelsQuery.isFetching}
                onToolChange={(tool) => {
                  setRunTool(tool)
                  setRunModel('')
                }}
                onModelChange={setRunModel}
                controlClass={controlClass}
                toolPlaceholder="- phase/default tool"
                modelPlaceholder="- default model"
                className="contents"
              />
              <ActionButton variant="primary" onClick={handleRun} disabled={runPending}>
                {runPending ? 'Running…' : 'Run'}
              </ActionButton>
            </div>
          ) : (
            <div className="text-xs text-[var(--text-secondary)]">
              No execution interactions found for this task yet.
            </div>
          )}
          {runError && <div className="text-xs text-[var(--status-failed)]">{runError}</div>}
        </>
      )}

      {!interactionsLoading && runInteractions.length > 0 && (
        <div className="flex flex-col gap-2">
          {runInteractions.map((item) => {
            const isLatestCompleted = item.status === 'completed' && item.id === latestCompletedId
            const isLatestFailed = item.status === 'failed' && item.id === latestFailedId
            const itemReviews = runReviews.filter((review) => review.interaction_id === item.id)
            const runReviewInteractions = getReviewsForRun(item.id, item.started_at)

            return (
              <InteractionEntry
                key={item.id}
                interaction={item}
                activeLogId={activeLogId}
                onToggleLog={(id) => setActiveLogId(activeLogId === id ? null : id)}
              >
                {item.status === 'completed' && item.diff && (
                  <Collapsible.Root open={expandedDiffs.has(item.id)} onOpenChange={() => toggleDiff(item.id)}>
                    <Collapsible.Trigger asChild>
                      <button
                        type="button"
                        className="text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                      >
                        {expandedDiffs.has(item.id) ? '▾ Hide diff' : '▸ Show diff'}
                      </button>
                    </Collapsible.Trigger>
                    <Collapsible.Content>
                      <DiffViewer
                        data={{
                          task_id: task.id,
                          title: task.title,
                          diff: item.diff,
                          files_changed: [],
                          actions: [],
                        }}
                      />
                    </Collapsible.Content>
                  </Collapsible.Root>
                )}

                {runReviewInteractions.length > 0 && (
                  <div className="flex flex-col gap-1.5">
                    {runReviewInteractions.map((reviewInteraction) => (
                      <AIReviewResultCard
                        key={reviewInteraction.id}
                        interaction={reviewInteraction}
                        dismissed={dismissedReviews.has(reviewInteraction.id)}
                        activeLogId={activeLogId}
                        onToggleLog={(id) => setActiveLogId(activeLogId === id ? null : id)}
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
                            setReviewExpanded(true)
                          }}
                        >
                          Request Changes
                        </ActionButton>
                        <ActionButton
                          variant="default"
                          onClick={() => {
                            setDismissedReviews(
                              (prev) => new Set([...prev, activeAISuggestion.interactionId]),
                            )
                          }}
                        >
                          Dismiss
                        </ActionButton>
                      </div>
                    </div>
                  ) : (
                    <InlineReviewActions
                      forceReviewExpanded={reviewExpanded}
                      prefillFeedback={activeAISuggestion?.feedback}
                    />
                  ))}

                {isLatestFailed && !readOnly && <FailedRunActions />}
              </InteractionEntry>
            )
          })}
        </div>
      )}
    </div>
  )
}
