import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../api'
import type { Task } from '../../types'

export const tasksKeys = {
  all: ['tasks'] as const,
  detail: (id: string) => ['tasks', id] as const,
}

export function useTasksQuery() {
  return useQuery({
    queryKey: tasksKeys.all,
    queryFn: () => api.listTasks(),
  })
}

export function useTaskQuery(id: string) {
  return useQuery({
    queryKey: tasksKeys.detail(id),
    queryFn: () => api.getTask(id),
    enabled: Boolean(id),
  })
}

export function useCreateTask() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: Partial<Task>) => api.createTask(data),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: tasksKeys.all })
    },
  })
}

export function useUpdateTask() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<Task> }) =>
      api.updateTask(id, data),
    onSuccess: async (_data, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: tasksKeys.all }),
        queryClient.invalidateQueries({
          queryKey: tasksKeys.detail(variables.id),
        }),
      ])
    },
  })
}

export function useDeleteTask() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.deleteTask(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: tasksKeys.all })
    },
  })
}
