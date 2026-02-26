import { useQuery } from '@tanstack/react-query'
import { api } from '../../api'
import { queryKeys } from '../../lib/queryKeys'

export function useTaskReviewsQuery(taskId: string) {
  return useQuery({
    queryKey: queryKeys.taskReviews(taskId),
    queryFn: () => api.getTaskReviews(taskId),
    enabled: Boolean(taskId),
  })
}
