import type { ListMemoryParams } from '../types';

function normalizeMemoryParams(params?: ListMemoryParams) {
  return {
    category: params?.category ?? null,
    tag: params?.tag ?? null,
    sourceType: params?.sourceType ?? null,
    filePath: params?.filePath ?? null,
    stale: params?.stale ?? null,
    coveredBefore: params?.coveredBefore ?? null,
    q: params?.q ?? null,
    limit: params?.limit ?? null,
  };
}

export const queryKeys = {
  tasks: ['tasks'] as const,
  task: (id: string) => ['task', id] as const,
  config: ['config'] as const,
  sessions: ['sessions'] as const,
  status: ['status'] as const,
  operations: (filters?: { targetId?: string; type?: string }) =>
    ['operations', filters ?? {}] as const,
  models: (tool?: string) => ['models', tool ?? null] as const,
  taskPlan: (taskId: string) => ['taskPlan', taskId] as const,
  taskReviews: (taskId: string) => ['task-reviews', taskId] as const,
  taskInteractions: (taskId: string) => ['task-interactions', taskId] as const,
  taskInteraction: (taskId: string, logId: string) =>
    ['task-interaction', taskId, logId] as const,
  interactionStubs: (taskId: string) => ['interaction-stubs', taskId] as const,
  interactionMeta: (taskId: string, id: string) =>
    ['interaction-meta', taskId, id] as const,
  memory: ['memory'] as const,
  memoryList: (params?: ListMemoryParams) =>
    ['memory', 'list', normalizeMemoryParams(params)] as const,
  memoryEntry: (id: string) => ['memory', 'entry', id] as const,
  memoryQuery: (q: string, limit?: number) =>
    ['memory', 'query', q, limit ?? null] as const,
  queue: ['queue'] as const,
  queueCounts: ['queue', 'counts'] as const,
  queueJob: (id: string) => ['queue', id] as const,
};
