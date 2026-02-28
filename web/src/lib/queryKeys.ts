export const queryKeys = {
  tasks: ['tasks'] as const,
  task: (id: string) => ['task', id] as const,
  config: ['config'] as const,
  sessions: ['sessions'] as const,
  status: ['status'] as const,
  operations: (filters?: { target_id?: string; type?: string }) =>
    ['operations', filters ?? {}] as const,
  models: (tool?: string) => ['models', tool ?? null] as const,
  taskPlan: (taskId: string) => ['taskPlan', taskId] as const,
  taskReviews: (taskId: string) => ['task-reviews', taskId] as const,
  taskInteractions: (taskId: string) => ['task-interactions', taskId] as const,
  taskInteraction: (taskId: string, logId: string) =>
    ['task-interaction', taskId, logId] as const,
}
