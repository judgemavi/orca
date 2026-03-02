import type { ListKnowledgeParams } from '../types'

function normalizeKnowledgeParams(params?: ListKnowledgeParams) {
  return {
    category: params?.category ?? null,
    tag: params?.tag ?? null,
    q: params?.q ?? null,
    limit: params?.limit ?? null,
  }
}

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
  knowledge: ['knowledge'] as const,
  knowledgeList: (params?: ListKnowledgeParams) =>
    ['knowledge', 'list', normalizeKnowledgeParams(params)] as const,
  knowledgeEntry: (id: string) => ['knowledge', 'entry', id] as const,
}
