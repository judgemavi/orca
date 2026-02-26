import { useQuery } from '@tanstack/react-query'
import { api } from '../../api'

interface OperationsFilters {
  target_id?: string
  type?: string
}

const operationsKeys = {
  all: ['operations'] as const,
  list: (filters?: OperationsFilters) => ['operations', filters ?? {}] as const,
}

export function useOperationsQuery(filters?: OperationsFilters) {
  return useQuery({
    queryKey: operationsKeys.list(filters),
    queryFn: () => api.listOperations(filters),
  })
}
