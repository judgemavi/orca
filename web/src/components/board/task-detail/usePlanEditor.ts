import { useEffect, useMemo, useState } from 'react'
import type { Interaction, Task } from '../../../types'
import { useSavePlanMutation, useTaskPlanQuery } from '../../../hooks/queries'
import {
  INTERACTION_STATUSES,
  PHASES,
  TASK_STATUSES,
} from '../../../lib/phases'
import { getErrorMessage } from '../../../lib/utils'

type Args = {
  taskId: string
  task: Task
  interactions: Interaction[]
  readOnly?: boolean
}

export function usePlanEditor({
  taskId,
  task,
  interactions,
  readOnly = false,
}: Args) {
  const taskPlanQuery = useTaskPlanQuery(taskId)
  const savePlanMutation = useSavePlanMutation()

  const [planDraft, setPlanDraft] = useState('')
  const [planEditing, setPlanEditing] = useState(true)
  const [planSaveError, setPlanSaveError] = useState<string | null>(null)

  const latestCompletedPlanInteraction =
    [...interactions]
      .reverse()
      .find(
        (item) =>
          item.phase === PHASES.plan &&
          item.status === INTERACTION_STATUSES.completed,
      ) ?? null

  const currentPlanText =
    taskPlanQuery.data ||
    task.plan ||
    latestCompletedPlanInteraction?.diff ||
    ''

  const latestCompletedPlanId = latestCompletedPlanInteraction?.id ?? null

  const planEditable = useMemo(() => {
    if (readOnly) return false
    return (
      task.status === TASK_STATUSES.pending ||
      task.status === TASK_STATUSES.planned
    )
  }, [readOnly, task.status])

  useEffect(() => {
    if (!taskId) return
    setPlanDraft(currentPlanText)
  }, [taskId, currentPlanText])

  useEffect(() => {
    if (!taskId) return
    setPlanEditing(true)
    setPlanSaveError(null)
  }, [taskId])

  const onSavePlan = async () => {
    setPlanSaveError(null)
    try {
      await savePlanMutation.mutateAsync({ taskId, plan: planDraft })
    } catch (err) {
      setPlanSaveError(getErrorMessage(err, 'Failed to save plan'))
    }
  }

  return {
    planDraft,
    setPlanDraft,
    planEditing,
    setPlanEditing,
    planSaveError,
    onSavePlan,
    planSaving: savePlanMutation.isPending,
    currentPlanText,
    latestCompletedPlanId,
    planEditable,
  }
}
