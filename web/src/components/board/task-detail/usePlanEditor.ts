import { useEffect, useMemo, useState } from 'react'
import type { Interaction, Task } from '../../../types'
import { useSavePlanMutation, useTaskPlanQuery } from '../../../hooks/queries'
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
      .find((item) => item.phase === 'plan' && item.status === 'completed') ??
    null

  const currentPlanText =
    taskPlanQuery.data ??
    task.plan ??
    latestCompletedPlanInteraction?.diff ??
    ''

  const latestCompletedPlanId = latestCompletedPlanInteraction?.id ?? null

  const planEditable = useMemo(() => {
    if (readOnly) return false
    return task.status === 'pending' || task.status === 'planned'
  }, [readOnly, task.status])

  useEffect(() => {
    setPlanDraft(currentPlanText)
  }, [currentPlanText])

  useEffect(() => {
    if (!taskId) return
    setPlanDraft('')
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
