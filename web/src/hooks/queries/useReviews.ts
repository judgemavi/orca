import { useQuery } from '@tanstack/react-query'
import { api } from '../../api'

export function useTaskReviewsQuery(taskId: string) {
  return useQuery({
    queryKey: ['task-reviews', taskId],
    queryFn: () => api.getTaskReviews(taskId),
    enabled: Boolean(taskId),
  })
}
