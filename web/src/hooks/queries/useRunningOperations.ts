import { useCallback, useMemo } from 'react'
import { useOperationsQuery } from './useOperations'

export function useRunningOperations() {
  const operationsQuery = useOperationsQuery()
  const operations = operationsQuery.data?.operations ?? []

  const runningOperations = useMemo(
    () => operations.filter((op) => op.status === 'running'),
    [operations],
  )

  const isRunning = useCallback(
    (type: string, targetId?: string) =>
      runningOperations.some(
        (op) =>
          op.type === type &&
          (targetId === undefined ||
            targetId === '' ||
            op.target_id === targetId),
      ),
    [runningOperations],
  )

  return { operations, isRunning }
}
