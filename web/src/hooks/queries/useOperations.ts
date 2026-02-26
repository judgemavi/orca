import { useQuery } from '@tanstack/react-query'
import { api } from '../../api'
import { queryKeys } from '../../lib/queryKeys'

interface OperationsFilters {
  target_id?: string
  type?: string
}

export function useOperationsQuery(filters?: OperationsFilters) {
  return useQuery({
    queryKey: queryKeys.operations(filters),
    queryFn: () => api.listOperations(filters),
  })
}
