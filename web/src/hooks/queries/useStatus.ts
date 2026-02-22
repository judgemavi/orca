import { useQuery } from '@tanstack/react-query'
import { api } from '../../api'

export const statusKeys = {
  status: ['status'] as const,
  costs: ['costs'] as const,
}

export function useStatusQuery() {
  return useQuery({
    queryKey: statusKeys.status,
    queryFn: () => api.getStatus(),
  })
}

export function useCostsQuery() {
  return useQuery({
    queryKey: statusKeys.costs,
    queryFn: () => api.getCosts(),
  })
}
