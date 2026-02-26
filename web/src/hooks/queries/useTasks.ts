import { useMutation, useQuery } from '@tanstack/react-query'
import { api } from '../../api'
import type { Task } from '../../types'

export function useTasksQuery() {
  return useQuery({
    queryKey: ['tasks'],
    queryFn: () => api.listTasks(),
  })
}

export function useCreateTask() {
  return useMutation({
    mutationFn: (data: Partial<Task>) => api.createTask(data),
  })
}

export function useUpdateTask() {
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<Task> }) =>
      api.updateTask(id, data),
  })
}

export function useDeleteTask() {
  return useMutation({
    mutationFn: (id: string) => api.deleteTask(id),
  })
}

export function useRunTasksMutation() {
  return useMutation({
    mutationFn: (taskIds?: string[]) => api.runTasks(taskIds),
  })
}
