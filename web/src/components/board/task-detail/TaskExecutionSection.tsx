import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTaskDetailContext } from '../../../context/TaskDetailContext'
import { useTaskReviewsQuery } from '../../../hooks/queries/useReviews'
import type { Interaction } from '../../../types'
import { DiffViewer } from '../../blocks/DiffViewer'
import { AIReviewResultCard } from './AIReviewResultCard'
import { InteractionEntry } from './InteractionEntry'
import { selectByPhase, useInteractionsQuery } from './useInteractions'

interface Props {
  readOnly?: boolean
}

export function TaskExecutionSection({ readOnly = false }: Props) {
  const { task, activeLogId, setActiveLogId } = useTaskDetailContext()

  const runInteractionsQuery = useInteractionsQuery(task.id, {
    select: selectByPhase('run'),
  })
  const reviewInteractionsQuery = useInteractionsQuery(task.id, {
    select: selectByPhase('review'),
  })
  const reviewsQuery = useTaskReviewsQuery(task.id)

  const [expandedInteractions, setExpandedInteractions] = useState<Set<string>>(
    new Set(),
  )

  const runInteractions = runInteractionsQuery.data ?? []
  const reviewInteractions = reviewInteractionsQuery.data ?? []

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

  const latestCompletedId =
    [...runInteractions].reverse().find((item) => item.status === 'completed')
      ?.id ?? null

  useEffect(() => {
    if (latestCompletedId) {
      setExpandedInteractions(new Set([latestCompletedId]))
      return
    }
    setExpandedInteractions(new Set())
  }, [latestCompletedId])

  function toggleInteraction(id: string) {
    setExpandedInteractions((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const getReviewsForRun = useCallback(
    (runId: string, runStartedAt: string): Interaction[] => {
      const runIndex = runInteractions.findIndex((run) => run.id === runId)
      const nextRunStartedAt =
        runIndex < runInteractions.length - 1
          ? runInteractions[runIndex + 1].started_at
          : null

      return reviewInteractions.filter((reviewInteraction) => {
        const reviewStart = Date.parse(reviewInteraction.started_at)
        const runStart = Date.parse(runStartedAt)
        if (!Number.isFinite(reviewStart) || !Number.isFinite(runStart))
          return false
        if (reviewStart < runStart) return false
        if (nextRunStartedAt && reviewStart >= Date.parse(nextRunStartedAt))
          return false
        return true
      })
    },
    [runInteractions, reviewInteractions],
  )

  return (
    <div className="flex flex-col gap-4 rounded-lg bg-surface p-4">
      {interactionsLoading && (
        <div className="text-xs">Loading interactions...</div>
      )}

      {!interactionsLoading && runInteractions.length === 0 && (
        <div className="text-xs">
          {task.status === 'planned' && !readOnly
            ? 'Run this task from the action bar below to start execution.'
            : 'No execution interactions found for this task yet.'}
        </div>
      )}

      {!interactionsLoading && runInteractions.length > 0 && (
        <div className="flex flex-col gap-2">
          {runInteractions.map((item) => {
            const itemReviews = runReviews.filter(
              (review) => review.interaction_id === item.id,
            )
            const runReviewInteractions = getReviewsForRun(
              item.id,
              item.started_at,
            )

            return (
              <InteractionEntry
                key={item.id}
                interaction={item}
                collapsible
                showDiffSummary
                expanded={item.status === 'running' || expandedInteractions.has(item.id)}
                alwaysExpanded={item.status === 'running'}
                onExpandedChange={() => toggleInteraction(item.id)}
                activeLogId={activeLogId}
                onToggleLog={(id) =>
                  setActiveLogId(activeLogId === id ? null : id)
                }
              >
                {item.status === 'completed' && item.diff && (
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

                {runReviewInteractions.length > 0 && (
                  <div className="flex flex-col gap-2">
                    {runReviewInteractions.map((reviewInteraction) => (
                      <AIReviewResultCard
                        key={reviewInteraction.id}
                        interaction={reviewInteraction}
                        activeLogId={activeLogId}
                        onToggleLog={(id) =>
                          setActiveLogId(activeLogId === id ? null : id)
                        }
                      />
                    ))}
                  </div>
                )}

                {item.status === 'completed' && itemReviews.length > 0 && (
                  <div className="flex flex-col gap-2">
                    {itemReviews.map((review) => (
                      <div
                        key={review.id}
                        className={[
                          'rounded-md border p-4',
                          review.status === 'pending'
                            ? 'border-amber-500/40 bg-amber-500/10'
                            : 'border-emerald-500/35 bg-emerald-500/10',
                        ].join(' ')}
                      >
                        <div className="mb-2 flex items-center gap-2">
                          <span className="text-xs font-medium uppercase tracking-wide">
                            Request Changes
                          </span>
                          <span
                            className={[
                              'text-xs font-medium uppercase tracking-wide',
                              review.status === 'pending'
                                ? 'text-amber-400'
                                : 'text-emerald-400',
                            ].join(' ')}
                          >
                            {review.status === 'pending'
                              ? 'Pending'
                              : 'Addressed'}
                          </span>
                        </div>
                        <div className="whitespace-pre-wrap text-xs">
                          {review.feedback}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </InteractionEntry>
            )
          })}
        </div>
      )}
    </div>
  )
}
