import { useQuery } from '@tanstack/react-query'
import { api } from '../../api'
import { queryKeys } from '../../lib/queryKeys'

export function useTasksQuery() {
  return useQuery({
    queryKey: queryKeys.tasks,
    queryFn: () => api.listTasks(),
  })
}
