import { useCallback, useEffect, useState } from 'react'
import { useTaskReviewsQuery } from '../../../hooks/queries'
import { useTaskDetailContext } from '../../../context/TaskDetailContext'
import { InteractionDetailProvider } from './InteractionDetailContext'
import { TaskInteractionItems } from './TaskInteractionItems'
import { useInteractionsQuery } from './useInteractions'
import { useMergeHandler } from './useMergeHandler'
import { usePlanEditor } from './usePlanEditor'
import { INTERACTION_STATUSES } from '../../../lib/phases'

interface Props {
  taskId: string
  readOnly?: boolean
}

export function TaskInteractionList({ taskId, readOnly = false }: Props) {
  const { task, tools, activeLogId, setActiveLogId, isOperationRunning } =
    useTaskDetailContext()

  const interactionsQuery = useInteractionsQuery(taskId, {
    select: (interactions) =>
      [...interactions].sort(
        (a, b) => Date.parse(a.started_at) - Date.parse(b.started_at),
      ),
  })
  const reviewsQuery = useTaskReviewsQuery(taskId)
  const interactions = interactionsQuery.data ?? []
  const reviews = reviewsQuery.data ?? []

  const [expandedInteractions, setExpandedInteractions] = useState<Set<string>>(
    new Set(),
  )

  const planEditor = usePlanEditor({ taskId, task, interactions, readOnly })
  const merge = useMergeHandler({
    taskId,
    taskStatus: task.status,
    isOperationRunning,
  })

  const latestCompletedId =
    [...interactions]
      .reverse()
      .find((item) => item.status === INTERACTION_STATUSES.completed)?.id ?? null

  useEffect(() => {
    setExpandedInteractions(
      latestCompletedId ? new Set([latestCompletedId]) : new Set(),
    )
  }, [latestCompletedId])

  const onToggleLog = useCallback(
    (id: string) => setActiveLogId(activeLogId === id ? null : id),
    [activeLogId, setActiveLogId],
  )

  const toggleInteraction = (id: string) => {
    setExpandedInteractions((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <InteractionDetailProvider value={{ activeLogId, onToggleLog }}>
      <div className="flex flex-col gap-4 rounded-lg bg-surface p-4">
        {interactionsQuery.isLoading && (
          <div className="text-xs">Loading interactions...</div>
        )}
        {!interactionsQuery.isLoading && interactions.length === 0 && (
          <div className="text-xs">No interactions yet.</div>
        )}
        {!interactionsQuery.isLoading && interactions.length > 0 && (
          <TaskInteractionItems
            interactions={interactions}
            reviews={reviews}
            task={task}
            tools={tools}
            readOnly={readOnly}
            expandedInteractions={expandedInteractions}
            onToggleInteraction={toggleInteraction}
            planEditor={planEditor}
            merge={merge}
          />
        )}
      </div>
    </InteractionDetailProvider>
  )
}
