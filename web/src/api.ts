// HTTP client for Orca API. All endpoints return typed promises.
// Server routes are chained Hono instances exporting AppType for future hc<> RPC client.

import type {
  Config,
  Interaction,
  InteractionStub,
  InteractionWithContent,
  Job,
  ListMemoryParams,
  MemoryEntry,
  MemoryEntryDetail,
  MemoryQueryResult,
  MemoryRefreshResult,
  MemorySyncResult,
  ModelInfo,
  Operation,
  ProjectStatus,
  ProposedTask,
  Task,
  TaskReview,
  UpdateMemoryInput,
} from './types';

const BASE = '/api/v1';

type ApiError = Error & {
  conflict?: boolean;
  taskId?: string;
  worktreePath?: string;
};

function withQuery(
  path: string,
  params: Record<string, string | undefined>,
): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) q.set(key, value);
  }
  const suffix = q.toString();
  return suffix ? `${path}?${suffix}` : path;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(options?.headers ?? {}),
    },
    ...options,
  });

  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }

  const errorMessage =
    json && typeof json === 'object' && typeof json.error === 'string'
      ? json.error
      : undefined;

  if (!res.ok || errorMessage) {
    const err = new Error(
      errorMessage || `Request failed: ${res.status}`,
    ) as ApiError;
    if (json && typeof json === 'object') Object.assign(err, json);
    throw err;
  }

  return json as T;
}

function normalizePlanText(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (payload && typeof payload === 'object') {
    const maybePlan = (payload as { plan?: unknown }).plan;
    if (typeof maybePlan === 'string') return maybePlan;
  }
  return '';
}

function post<T>(path: string, body: unknown = {}): Promise<T> {
  return request<T>(path, { method: 'POST', body: JSON.stringify(body) });
}

function put<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'PUT', body: JSON.stringify(body) });
}

function patch<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
}

function del<T = void>(path: string): Promise<T> {
  return request<T>(path, { method: 'DELETE' });
}

export const api = {
  listTasks: () => request<Task[]>('/tasks'),
  getTask: (id: string) => request<Task>(`/tasks/${id}`),
  createTask: (data: Partial<Task>) => post<{ task: Task }>('/tasks', data),
  updateTask: (id: string, data: Partial<Task> & { sessionId?: string }) =>
    patch<{ task: Task }>(`/tasks/${id}`, data),
  deleteTask: (id: string) => del<string>(`/tasks/${id}`),

  listOperations: (params?: { targetId?: string; type?: string }) =>
    request<Operation[]>(
      withQuery('/operations', {
        targetId: params?.targetId,
        type: params?.type,
      }),
    ),

  listMemory: (params?: ListMemoryParams) =>
    request<MemoryEntry[]>(
      withQuery('/memory', {
        category: params?.category,
        tag: params?.tag,
        sourceType: params?.sourceType,
        filePath: params?.filePath,
        stale:
          typeof params?.stale === 'boolean' ? String(params.stale) : undefined,
        coveredBefore: params?.coveredBefore,
        q: params?.q,
        limit:
          typeof params?.limit === 'number' ? String(params.limit) : undefined,
      }),
    ),
  queryMemory: (q: string, limit?: number) =>
    request<MemoryQueryResult[]>(
      withQuery('/memory/query', {
        q,
        limit: typeof limit === 'number' ? String(limit) : undefined,
      }),
    ),
  getMemory: (id: string) =>
    request<MemoryEntryDetail>(`/memory/${encodeURIComponent(id)}`),
  updateMemory: (id: string, data: UpdateMemoryInput) =>
    patch<MemoryEntry>(`/memory/${encodeURIComponent(id)}`, data),
  deleteMemory: (id: string) =>
    del<{ deleted: string }>(`/memory/${encodeURIComponent(id)}`),
  syncMemory: () => post<MemorySyncResult>('/memory/sync'),
  refreshMemory: (entryId?: string) =>
    post<MemoryRefreshResult>('/memory/refresh', {
      ...(entryId ? { entryId: entryId } : {}),
    }),
  getStatus: () => request<ProjectStatus>('/status'),

  merge: () => post<{ operationId: string }>('/merge'),
  startTasks: (taskIds?: string[], tool?: string, model?: string) =>
    post<{ operationId: string; taskIds: string[] }>('/tasks/start', {
      ...(taskIds ? { taskIds: taskIds } : {}),
      ...(tool ? { tool } : {}),
      ...(model ? { model } : {}),
    }),
  stopTask: (id: string) => post<{ status: string }>(`/tasks/${id}/stop`),
  resumeTask: (id: string, opts?: { sessionId?: string; feedback?: string }) =>
    post<{ status: string }>(`/tasks/${id}/resume`, opts ?? {}),
  cancelTask: (id: string) => api.stopTask(id),
  mergeTask: (taskId: string, mode?: string, tool?: string, model?: string) =>
    request<{ operationId: string }>(`/tasks/${taskId}/merge`, {
      method: 'POST',
      body:
        mode || tool || model
          ? JSON.stringify({
              ...(mode ? { mode } : {}),
              ...(tool ? { tool } : {}),
              ...(model ? { model } : {}),
            })
          : undefined,
    }),
  runExplore: () => post<{ status: string }>('/explore'),
  getTaskReviews: (id: string) => request<TaskReview[]>(`/tasks/${id}/reviews`),
  listInteractions: (taskId: string) =>
    request<Interaction[]>(`/tasks/${taskId}/interactions`),
  listInteractionStubs: (taskId: string) =>
    request<InteractionStub[]>(`/tasks/${taskId}/interactions?fields=stub`),
  getInteraction: (taskId: string, logId: string) =>
    request<InteractionWithContent>(
      `/tasks/${taskId}/interactions/${encodeURIComponent(logId)}`,
    ),
  getInteractionMeta: (taskId: string, id: string) =>
    request<Interaction>(
      `/tasks/${taskId}/interactions/${encodeURIComponent(id)}?content=0`,
    ),
  approveTask: (id: string) => post<Task>(`/tasks/${id}/approve`),
  approvePlan: (id: string) => post<Task>(`/tasks/${id}/approve-plan`),
  requestChanges: (
    id: string,
    feedback: string,
    interactionId?: string,
    tool?: string,
    model?: string,
  ) =>
    post<{ status: string; taskId: string }>(`/tasks/${id}/request-changes`, {
      feedback,
      ...(interactionId ? { interactionId: interactionId } : {}),
      ...(tool ? { tool } : {}),
      ...(model ? { model } : {}),
    }),
  aiReview: (id: string, tool?: string, model?: string, prompt?: string) =>
    post<{ status: string; taskId: string }>(`/tasks/${id}/ai-review`, {
      ...(tool ? { tool } : {}),
      ...(model ? { model } : {}),
      ...(prompt ? { prompt } : {}),
    }),
  evaluateTask: (id: string, tool?: string, model?: string) =>
    post<{
      taskId: string;
      status: string;
    }>(`/tasks/${id}/evaluate`, {
      ...(tool ? { tool } : {}),
      ...(model ? { model } : {}),
    }),
  breakdownTask: (id: string, tool?: string, model?: string) =>
    post<{
      taskId: string;
      status: string;
    }>(`/tasks/${id}/breakdown`, {
      ...(tool ? { tool } : {}),
      ...(model ? { model } : {}),
    }),
  acceptBreakdown: (
    id: string,
    interactionId: string,
    tasks?: ProposedTask[],
  ) =>
    post<{
      created: number;
      taskIds: string[];
      parentId?: string;
    }>(`/tasks/${id}/breakdown/accept`, {
      interactionId: interactionId,
      ...(tasks ? { tasks } : {}),
    }),
  rejectBreakdown: (id: string, interactionId: string) =>
    post<{
      rejected: boolean;
    }>(`/tasks/${id}/breakdown/reject`, {
      interactionId: interactionId,
    }),
  requestPlanChanges: (
    id: string,
    feedback: string,
    interactionId?: string,
    tool?: string,
    model?: string,
  ) =>
    post<{ status: string }>(`/tasks/${id}/request-plan-changes`, {
      feedback,
      ...(interactionId ? { interactionId: interactionId } : {}),
      ...(tool ? { tool } : {}),
      ...(model ? { model } : {}),
    }),
  getConfig: () => request<Config>('/config'),
  updateConfig: (cfgPatch: Partial<Config>) => put<Config>('/config', cfgPatch),
  listModels: (tool?: string): Promise<Record<string, ModelInfo[]>> =>
    request<{ tools: Record<string, ModelInfo[]> }>(
      withQuery('/models', { tool }),
    ).then((r) => r.tools),
  getTaskPlan: async (taskId: string): Promise<string> =>
    normalizePlanText(await request<unknown>(`/tasks/${taskId}/plan`)),
  saveTaskPlan: (taskId: string, plan: string): Promise<void> =>
    put<void>(`/tasks/${taskId}/plan`, { plan }),
  generateTaskPlan: (
    taskId: string,
    opts?: { tool?: string; model?: string },
  ): Promise<void> => post<void>(`/tasks/${taskId}/plan/generate`, opts ?? {}),
  addDependency: (taskId: string, dependsOn: string) =>
    post(`/tasks/${taskId}/deps`, { dependsOn: dependsOn }),
  listSessions: () =>
    request<
      Array<{
        id: string;
        type: string;
        tool: string;
        taskId: string;
        cols: number;
        rows: number;
        createdAt: string;
      }>
    >('/sessions'),
  listQueue: (params?: { status?: string; taskId?: string; limit?: number }) =>
    request<Job[]>(
      withQuery('/queue', {
        status: params?.status,
        taskId: params?.taskId,
        limit: params?.limit != null ? String(params.limit) : undefined,
      }),
    ),
  getQueueJob: (id: string) => request<Job>(`/queue/${id}`),
  getQueueCounts: () => request<Record<string, number>>('/queue/counts'),
  cancelQueueJob: (id: string) => del<{ cancelled: boolean }>(`/queue/${id}`),
  drainQueue: () => del<{ cancelled: number }>('/queue'),
};
