import type {
  Block,
  Task,
  Sprint,
  ProposedTask,
  ProjectStatus,
  ReviewArtifact,
  ModelInfo,
  Operation,
  LogEntry,
} from './types'

const BASE = '/api/v1'

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  const json = await res.json()
  if (json.error) {
    const err = new Error(json.error) as Error & {
      conflict?: boolean
      task_id?: string
      worktree_path?: string
    }
    if (json.conflict) err.conflict = true
    if (json.task_id) err.task_id = json.task_id
    if (json.worktree_path) err.worktree_path = json.worktree_path
    throw err
  }
  return json.data !== undefined ? json.data : json
}

export const api = {
  chat: (message: string, sessionId: string) =>
    request<{ blocks: Block[] }>('/chat', {
      method: 'POST',
      body: JSON.stringify({ message, session_id: sessionId }),
    }),

  listTasks: () => request<{ tasks: Task[] }>('/tasks'),
  getTask: (id: string) => request<{ task: Task }>(`/tasks/${id}`),
  createTask: (data: Partial<Task>) =>
    request<{ task: Task }>('/tasks', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateTask: (id: string, data: Partial<Task>) =>
    request<{ task: Task }>(`/tasks/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  deleteTask: (id: string) => request(`/tasks/${id}`, { method: 'DELETE' }),

  listSprints: (all?: boolean) =>
    request<{ sprints: Sprint[] }>(`/sprints${all ? '?all=true' : ''}`),
  listOperations: (params?: { target_id?: string; type?: string }) => {
    const q = new URLSearchParams()
    if (params?.target_id) q.set('target_id', params.target_id)
    if (params?.type) q.set('type', params.type)
    const suffix = q.toString() ? `?${q.toString()}` : ''
    return request<{ operations: Operation[] }>(`/operations${suffix}`)
  },
  getActiveSprint: () => request<Sprint | null>('/sprints/active'),
  getSprint: (id: string) => request<Sprint>(`/sprints/${id}`),
  planSprint: () => request<Sprint>('/sprints/plan', { method: 'POST' }),
  sprintAssign: (taskId: string, sprintId?: string) =>
    request<Sprint>('/sprints/assign', {
      method: 'POST',
      body: JSON.stringify({ task_id: taskId, sprint_id: sprintId }),
    }),
  sprintUnassign: (taskId: string) =>
    request('/sprints/unassign', {
      method: 'POST',
      body: JSON.stringify({ task_id: taskId }),
    }),
  startSprint: (id: string) =>
    request<{ sprint_id: string }>(`/sprints/${id}/start`, { method: 'POST' }),
  cancelSprint: (id: string) =>
    request(`/sprints/${id}/cancel`, { method: 'POST' }),
  resetSprint: (id: string) =>
    request(`/sprints/${id}/reset`, { method: 'POST' }),
  getReview: (sprintId: string) =>
    request<{ sprint_id: string; artifacts: ReviewArtifact[] }>(
      `/sprints/${sprintId}/review`,
    ),
  startReview: (sprintId: string) =>
    request<{ operation_id: string }>(`/sprints/${sprintId}/review`, {
      method: 'POST',
      body: JSON.stringify({ auto: true }),
    }),

  plan: (goal: string, tool: string) =>
    request<{ operation_id: string }>('/plan', {
      method: 'POST',
      body: JSON.stringify({ goal, tool }),
    }),
  acceptPlan: (
    operationId: string,
    tasks: ProposedTask[],
    sessionId?: string,
  ) =>
    request('/plan/accept', {
      method: 'POST',
      body: JSON.stringify({
        operation_id: operationId,
        session_id: sessionId,
        tasks,
      }),
    }),
  rejectPlan: (operationId: string, sessionId?: string) =>
    request('/plan/reject', {
      method: 'POST',
      body: JSON.stringify({
        operation_id: operationId,
        session_id: sessionId,
      }),
    }),

  integrate: (sprintId?: string) =>
    request<{ operation_id: string }>('/integrate', {
      method: 'POST',
      body: JSON.stringify(sprintId ? { sprint_id: sprintId } : {}),
    }),
  mergeTask: (taskId: string, mode?: string) =>
    request<{ operation_id: string }>(`/tasks/${taskId}/merge`, {
      method: 'POST',
      body: mode ? JSON.stringify({ mode }) : undefined,
    }),

  explore: () => request('/explore', { method: 'POST' }),

  autopilotStart: (
    goal: string,
    opts?: { max_sprints?: number; unattended?: boolean },
  ) =>
    request<{ status: string }>('/autopilot/start', {
      method: 'POST',
      body: JSON.stringify({ goal, ...opts }),
    }),
  autopilotStop: () =>
    request<{ status: string }>('/autopilot/stop', { method: 'POST' }),
  autopilotRespond: (cont: boolean) =>
    request<{ status: string }>('/autopilot/respond', {
      method: 'POST',
      body: JSON.stringify({ continue: cont }),
    }),
  autopilotStatus: () =>
    request<{
      autopilot_running: boolean
      sprint_active: boolean
      sprint_id?: string
    }>('/autopilot/status'),

  getStatus: () => request<ProjectStatus>('/status'),
  getCosts: () => request('/costs'),
  getConfig: () => request('/config'),
  listModels: async (tool?: string): Promise<Record<string, ModelInfo[]>> => {
    const query = tool ? `?tool=${encodeURIComponent(tool)}` : ''
    const data = await request<{ tools: Record<string, ModelInfo[]> }>(
      `/models${query}`,
    )
    return data.tools ?? {}
  },
  getTaskPlan: async (taskId: string): Promise<string> => {
    const data = await request<{ plan: string }>(`/tasks/${taskId}/plan`)
    return data.plan ?? ''
  },
  saveTaskPlan: async (taskId: string, plan: string): Promise<void> => {
    await request(`/tasks/${taskId}/plan`, {
      method: 'PUT',
      body: JSON.stringify({ plan }),
    })
  },
  generateTaskPlan: async (
    taskId: string,
    opts?: { tool?: string; model?: string },
  ): Promise<void> => {
    await request(`/tasks/${taskId}/plan/generate`, {
      method: 'POST',
      body: JSON.stringify(opts ?? {}),
    })
  },
  getTaskLogs: async (taskId: string, tail?: number): Promise<string[]> => {
    const q = typeof tail === 'number' && tail > 0 ? `?tail=${tail}` : ''
    const data = await request<{ lines: string[] }>(`/tasks/${taskId}/logs${q}`)
    return data.lines ?? []
  },
  listLogs: async (status?: string): Promise<LogEntry[]> => {
    const q = status ? `?status=${encodeURIComponent(status)}` : ''
    const data = await request<{ logs: LogEntry[] }>(`/logs${q}`)
    return data.logs ?? []
  },
  reopenTask: async (taskId: string): Promise<void> => {
    await request(`/tasks/${taskId}/reopen`, { method: 'POST' })
  },
  cleanup: async (dryRun?: boolean): Promise<{ operation_id: string }> => {
    const data = await request<{ operation_id: string }>('/cleanup', {
      method: 'POST',
      body: JSON.stringify(dryRun === undefined ? {} : { dry_run: dryRun }),
    })
    return { operation_id: data.operation_id }
  },
  addDependency: (taskId: string, dependsOn: string) =>
    request(`/tasks/${taskId}/deps`, {
      method: 'POST',
      body: JSON.stringify({ depends_on: dependsOn }),
    }),
}
