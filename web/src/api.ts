// HTTP client for Orca API. All endpoints return typed promises.

import type {
  Task,
  TaskReview,
  ModelInfo,
  Operation,
  Config,
  Interaction,
  InteractionWithContent,
} from './types'

const BASE = '/api/v1'

type ApiError = Error & {
  conflict?: boolean
  task_id?: string
  worktree_path?: string
}

function withQuery(
  path: string,
  params: Record<string, string | undefined>,
): string {
  const q = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value) q.set(key, value)
  }
  const suffix = q.toString()
  return suffix ? `${path}?${suffix}` : path
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(options?.headers ?? {}),
    },
    ...options,
  })

  let json: any = null
  try {
    json = await res.json()
  } catch {
    json = null
  }

  const errorMessage =
    json && typeof json === 'object' && typeof json.error === 'string'
      ? json.error
      : undefined

  if (!res.ok || errorMessage) {
    const err = new Error(
      errorMessage || `Request failed: ${res.status}`,
    ) as ApiError
    if (json && typeof json === 'object') Object.assign(err, json)
    throw err
  }

  return json && typeof json === 'object' && json.data !== undefined
    ? (json.data as T)
    : (json as T)
}

function post<T>(path: string, body: unknown = {}): Promise<T> {
  return request<T>(path, { method: 'POST', body: JSON.stringify(body) })
}

function put<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'PUT', body: JSON.stringify(body) })
}

function patch<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'PATCH', body: JSON.stringify(body) })
}

function del<T = void>(path: string): Promise<T> {
  return request<T>(path, { method: 'DELETE' })
}

export const api = {
  listTasks: () => request<{ tasks: Task[] }>('/tasks'),
  createTask: (data: Partial<Task>) => post<{ task: Task }>('/tasks', data),
  updateTask: (id: string, data: Partial<Task>) =>
    patch<{ task: Task }>(`/tasks/${id}`, data),
  deleteTask: (id: string) => del(`/tasks/${id}`),

  listOperations: (params?: { target_id?: string; type?: string }) =>
    request<{ operations: Operation[] }>(
      withQuery('/operations', {
        target_id: params?.target_id,
        type: params?.type,
      }),
    ),

  merge: () => post<{ operation_id: string }>('/merge'),
  runTasks: (taskIds?: string[], tool?: string, model?: string) =>
    post<{ operation_id: string; task_ids: string[] }>('/tasks/run', {
      ...(taskIds ? { task_ids: taskIds } : {}),
      ...(tool ? { tool } : {}),
      ...(model ? { model } : {}),
    }),
  mergeTask: (taskId: string, mode?: string, tool?: string, model?: string) =>
    request<{ operation_id: string }>(`/tasks/${taskId}/merge`, {
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
  getTaskReviews: (id: string) =>
    request<{ reviews: TaskReview[] }>(`/tasks/${id}/reviews`),
  listInteractions: (taskId: string) =>
    request<{ interactions: Interaction[] }>(`/tasks/${taskId}/interactions`),
  getInteraction: (taskId: string, logId: string) =>
    request<InteractionWithContent>(
      `/tasks/${taskId}/interactions/${encodeURIComponent(logId)}`,
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
    post<{ status: string; task_id: string }>(`/tasks/${id}/request-changes`, {
      feedback,
      ...(interactionId ? { interaction_id: interactionId } : {}),
      ...(tool ? { tool } : {}),
      ...(model ? { model } : {}),
    }),
  aiReview: (id: string, tool?: string, model?: string, prompt?: string) =>
    post<{ status: string; task_id: string }>(`/tasks/${id}/ai-review`, {
      ...(tool ? { tool } : {}),
      ...(model ? { model } : {}),
      ...(prompt ? { prompt } : {}),
    }),
  evaluateTask: (id: string, tool?: string, model?: string) =>
    post<{
      task_id: string
      evaluation: {
        should_decompose: boolean
        complexity: string
        reasoning: string
      }
    }>(`/tasks/${id}/evaluate`, {
      ...(tool ? { tool } : {}),
      ...(model ? { model } : {}),
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
      ...(interactionId ? { interaction_id: interactionId } : {}),
      ...(tool ? { tool } : {}),
      ...(model ? { model } : {}),
    }),
  getConfig: () => request<Config>('/config'),
  updateConfig: (cfgPatch: Partial<Config>) => put<Config>('/config', cfgPatch),
  listModels: (tool?: string): Promise<Record<string, ModelInfo[]>> =>
    request<{ tools: Record<string, ModelInfo[]> }>(
      withQuery('/models', { tool }),
    ).then((data) => data.tools ?? {}),
  getTaskPlan: (taskId: string): Promise<string> =>
    request<{ plan: string }>(`/tasks/${taskId}/plan`).then(
      (data) => data.plan ?? '',
    ),
  saveTaskPlan: (taskId: string, plan: string): Promise<void> =>
    put<void>(`/tasks/${taskId}/plan`, { plan }),
  generateTaskPlan: (
    taskId: string,
    opts?: { tool?: string; model?: string },
  ): Promise<void> => post<void>(`/tasks/${taskId}/plan/generate`, opts ?? {}),
  addDependency: (taskId: string, dependsOn: string) =>
    post(`/tasks/${taskId}/deps`, { depends_on: dependsOn }),
  listSessions: () =>
    request<{
      sessions: Array<{
        id: string
        type: string
        tool: string
        task_id: string
        cols: number
        rows: number
        created_at: string
      }>
    }>('/sessions'),
  startOrchestrator: () => post<{ status: string }>('/orchestrator/start'),
}
