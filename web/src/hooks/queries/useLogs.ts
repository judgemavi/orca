import { useQuery } from '@tanstack/react-query'
import { api } from '../../api'

export const logsKeys = {
  all: ['logs'] as const,
  list: (status?: string) => ['logs', status ?? 'all'] as const,
}

export function useLogsQuery(status?: string) {
  return useQuery({
    queryKey: logsKeys.list(status),
    queryFn: () => api.listLogs(status),
  })
}
