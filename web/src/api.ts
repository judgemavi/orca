import type { AppType } from '@orca/server';
import { hc } from 'hono/client';
import type {
  Config,
  EmbeddingConfigField,
  Interaction,
  InteractionWithContent,
  Job,
  ListMemoryParams,
  MemoryEntry,
  MemoryEntryDetail,
  MemoryQueryResult,
  MemoryRefreshResult,
  MemorySyncResult,
  ModelInfo,
  ProjectStatus,
  ProposedTask,
  Task,
  UpdateMemoryInput,
} from './types';

export type WorkflowStepInfo = {
  type: string;
  executor: string | null;
  steps?: Record<string, WorkflowStepInfo>;
};

export type Operation = {
  id: string;
  type: string;
  targetId: string;
  status: string;
  createdAt: string;
  updatedAt: string;
};

const client = hc<AppType>('/api/v1');

type ApiError = Error & {
  conflict?: boolean;
  taskId?: string;
  worktreePath?: string;
};

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (item): item is string => typeof item === 'string',
        );
      }
    } catch {
      return value.trim() ? [value] : [];
    }
  }
  return [];
}

function normalizeMemoryEntry(value: unknown): MemoryEntry {
  const source = value as Record<string, unknown>;
  return {
    ...(source as MemoryEntry),
    category: source.category as MemoryEntry['category'],
    tags: toStringArray(source.tags),
    sourceType: source.sourceType as MemoryEntry['sourceType'],
    stale: Boolean(source.stale),
    confidence:
      typeof source.confidence === 'number'
        ? source.confidence
        : Number(source.confidence ?? 0),
    retrievalCount:
      typeof source.retrievalCount === 'number'
        ? source.retrievalCount
        : Number(source.retrievalCount ?? 0),
    decayExempt: Boolean(source.decayExempt),
    filePaths: toStringArray(source.filePaths),
    sourceTaskId:
      typeof source.sourceTaskId === 'string' ? source.sourceTaskId : undefined,
    sourceInteractionId:
      typeof source.sourceInteractionId === 'string'
        ? source.sourceInteractionId
        : undefined,
    supersededBy:
      typeof source.supersededBy === 'string' ? source.supersededBy : undefined,
    coveredAtCommit:
      typeof source.coveredAtCommit === 'string'
        ? source.coveredAtCommit
        : undefined,
  };
}

function normalizeMemoryDetail(value: unknown): MemoryEntryDetail {
  const source = value as Record<string, unknown>;
  return {
    entry: normalizeMemoryEntry(source.entry),
    usedByTasks: Array.isArray(source.usedByTasks)
      ? (source.usedByTasks as MemoryEntryDetail['usedByTasks'])
      : [],
    supersedes: Array.isArray(source.supersedes)
      ? source.supersedes.filter(
          (item): item is string => typeof item === 'string',
        )
      : [],
  };
}

function normalizeMemoryQueryResults(value: unknown): MemoryQueryResult[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const source = item as Record<string, unknown>;
    return {
      entry: normalizeMemoryEntry(source.entry),
      score:
        typeof source.score === 'number'
          ? source.score
          : Number(source.score ?? 0),
      usedByTasks: Array.isArray(source.usedByTasks)
        ? (source.usedByTasks as MemoryQueryResult['usedByTasks'])
        : [],
    };
  });
}

async function unwrap<T>(req: Promise<Response>): Promise<T> {
  const res = await req;
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    /* empty body */
  }

  if (!res.ok) {
    const body = isErrorBody(json) ? json : null;
    const msg = body?.error ?? `Request failed: ${res.status}`;
    const err = new Error(msg) as ApiError;
    if (body) Object.assign(err, body);
    throw err;
  }
  return json as T;
}

function isErrorBody(v: unknown): v is { error: string; [k: string]: unknown } {
  return (
    v != null &&
    typeof v === 'object' &&
    typeof (v as Record<string, unknown>).error === 'string'
  );
}

export const api = {
  // Tasks
  listTasks: (): Promise<Task[]> => unwrap(client.tasks.$get()),
  getTask: (id: string): Promise<Task> =>
    unwrap(client.tasks[':id'].$get({ param: { id } })),
  createTask: (data: Pick<Task, 'title'> & Partial<Task>): Promise<Task> =>
    unwrap(
      client.tasks.$post({
        json: {
          ...data,
          workflow: data.workflow ?? undefined,
          autoRunOverrides: data.autoRunOverrides as
            | Record<string, boolean>
            | undefined,
        },
      }),
    ),
  updateTask: (
    id: string,
    data: Partial<Task> & { sessionId?: string | null },
  ): Promise<Task> =>
    unwrap(
      client.tasks[':id'].$patch({
        param: { id },
        json: {
          ...data,
          autoRunOverrides: data.autoRunOverrides as
            | Record<string, boolean>
            | undefined,
        },
      }),
    ),
  deleteTask: (id: string): Promise<{ deleted: string }> =>
    unwrap(client.tasks[':id'].$delete({ param: { id } })),
  // Interactions
  listOperations: (params?: {
    targetId?: string;
    type?: string;
  }): Promise<Operation[]> =>
    unwrap(
      client.operations.$get({
        query: { targetId: params?.targetId, type: params?.type },
      }),
    ),
  listInteractions: (taskId: string): Promise<Interaction[]> =>
    unwrap(client.tasks[':id'].interactions.$get({ param: { id: taskId } })),
  getInteraction: (
    taskId: string,
    logId: string,
  ): Promise<InteractionWithContent> =>
    unwrap(
      client.tasks[':id'].interactions[':interactionID'].$get({
        param: { id: taskId, interactionID: logId },
      }),
    ),
  getInteractionMeta: (taskId: string, id: string): Promise<Interaction> =>
    unwrap(
      client.tasks[':id'].interactions[':interactionID'].$get({
        param: { id: taskId, interactionID: id },
      }),
    ),

  getInteractionDiff: async (
    taskId: string,
    interactionId: string,
  ): Promise<{ diff: string; filesChanged: string[] }> => {
    const res = await fetch(
      `/api/v1/tasks/${taskId}/interactions/${interactionId}/diff`,
    );
    if (!res.ok) return { diff: '', filesChanged: [] };
    return res.json();
  },

  // Run / Start / Stop
  startTask: (
    taskId: string,
    tool?: string,
    model?: string,
  ): Promise<{ status: string; taskId: string; jobId: string }> =>
    unwrap(
      client.tasks[':id'].start.$post({
        param: { id: taskId },
        json: { tool, model },
      }),
    ),
  stopTask: (id: string): Promise<{ taskId: string; status: string }> =>
    unwrap(client.tasks[':id'].stop.$post({ param: { id } })),
  resumeTask: (
    id: string,
    opts?: { sessionId?: string; feedback?: string },
  ): Promise<{ status: string }> =>
    unwrap(
      client.tasks[':id'].resume.$post({
        param: { id },
        json: opts ?? {},
      }),
    ),
  mergeTask: (
    taskId: string,
  ): Promise<{ status: string; taskId: string; jobId: string }> =>
    unwrap(
      client.tasks[':id'].start.$post({
        param: { id: taskId },
        json: {},
      }),
    ),

  // Workflow
  approveTask: (id: string): Promise<Task> =>
    unwrap(client.tasks[':id'].approve.$post({ param: { id } })),
  requestChanges: (
    id: string,
    feedback: string,
    interactionId?: string,
    tool?: string,
    model?: string,
  ): Promise<{ status: string; taskId: string }> =>
    unwrap(
      client.tasks[':id']['request-changes'].$post({
        param: { id },
        json: { feedback, interactionId, tool, model },
      }),
    ),
  evaluateTask: (
    id: string,
    tool?: string,
    model?: string,
  ): Promise<{ taskId: string; status: string }> =>
    unwrap(
      client.tasks[':id'].evaluate.$post({
        param: { id },
        json: { tool, model },
      }),
    ),
  breakdownTask: (
    id: string,
    tool?: string,
    model?: string,
  ): Promise<{ taskId: string; status: string }> =>
    unwrap(
      client.tasks[':id'].breakdown.$post({
        param: { id },
        json: { tool, model },
      }),
    ),
  acceptBreakdown: (
    id: string,
    interactionId: string,
    tasks?: ProposedTask[],
  ): Promise<{ created: number; taskIds: string[]; parentId?: string }> =>
    unwrap(
      client.tasks[':id'].breakdown.accept.$post({
        param: { id },
        json: { interactionId, tasks },
      }),
    ),
  rejectBreakdown: (
    id: string,
    interactionId: string,
  ): Promise<{ rejected: boolean }> =>
    unwrap(
      client.tasks[':id'].breakdown.reject.$post({
        param: { id },
        json: { interactionId },
      }),
    ),

  // Step advancement
  runStep: (
    id: string,
    opts?: { tool?: string; model?: string; prompt?: string },
  ): Promise<{ taskId: string; jobId: string; status: string }> =>
    unwrap(
      client.tasks[':id'].step.run.$post({
        param: { id },
        json: opts ?? {},
      }),
    ),

  getWorkflowSteps: async (
    id: string,
  ): Promise<{
    workflow: string;
    steps: Record<string, WorkflowStepInfo>;
  }> => {
    const res = await fetch(`/api/v1/tasks/${id}/workflow/steps`);
    if (!res.ok) throw new Error('Failed to fetch workflow steps');
    return res.json();
  },

  getCurrentStep: async (
    id: string,
  ): Promise<{
    step: {
      name: string;
      type: string;
      executor: string | null;
      branches: Array<{ name: string; fields: string[] }>;
    } | null;
  }> => {
    const res = await fetch(`/api/v1/tasks/${id}/step/current`);
    if (!res.ok) throw new Error('Failed to fetch step info');
    return res.json();
  },

  completeStep: async (
    id: string,
    body: { outcome: string; [key: string]: unknown },
  ): Promise<{ taskId: string; outcome: string }> => {
    const res = await fetch(`/api/v1/tasks/${id}/step/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Request failed' }));
      throw new Error((err as { error?: string }).error ?? 'Request failed');
    }
    return res.json();
  },

  manualStep: (
    id: string,
    body: { output: string; outcome?: string },
  ): Promise<{ taskId: string; interactionId: string; step: string }> =>
    unwrap(
      client.tasks[':id'].step.manual.$post({
        param: { id },
        json: body,
      }),
    ),

  updateInteractionOutput: (
    taskId: string,
    interactionId: string,
    output: string,
  ): Promise<{ taskId: string; interactionId: string; updated: boolean }> =>
    unwrap(
      (client.tasks[':id'].interactions as any)[':interactionId'].output.$patch(
        {
          param: { id: taskId, interactionId },
          json: { output },
        },
      ),
    ),

  // User Input
  provideInput: (
    id: string,
    answer: string,
  ): Promise<{ taskId: string; jobId: string; status: string }> =>
    unwrap(
      client.tasks[':id'].input.$post({
        param: { id },
        json: { answer },
      }),
    ),
  getPendingQuestion: async (
    taskId: string,
  ): Promise<{ id: string; question: string; status: string } | null> => {
    const res = await fetch(`/api/v1/tasks/${taskId}/questions/pending`);
    if (!res.ok) return null;
    const data: unknown = await res.json();
    if (!data || typeof data !== 'object') return null;
    return data as { id: string; question: string; status: string };
  },

  // Explore (moved under memory)
  runExplore: (): Promise<{ status: string }> =>
    unwrap(client.memory.explore.$post({ json: {} })),

  // Memory
  listMemory: async (params?: ListMemoryParams): Promise<MemoryEntry[]> => {
    const entries = await unwrap<unknown>(
      client.memory.$get({
        query: {
          category: params?.category,
          tag: params?.tag,
          sourceType: params?.sourceType,
          filePath: params?.filePath,
          stale:
            typeof params?.stale === 'boolean'
              ? String(params.stale)
              : undefined,
          coveredBefore: params?.coveredBefore,
          q: params?.q,
          limit:
            typeof params?.limit === 'number'
              ? String(params.limit)
              : undefined,
        },
      }),
    );
    return Array.isArray(entries)
      ? entries.map((entry) => normalizeMemoryEntry(entry))
      : [];
  },
  queryMemory: async (
    q: string,
    limit?: number,
  ): Promise<MemoryQueryResult[]> => {
    const results = await unwrap<unknown>(
      client.memory.query.$get({
        query: {
          q,
          limit: typeof limit === 'number' ? String(limit) : undefined,
        },
      }),
    );
    return normalizeMemoryQueryResults(results);
  },
  getMemory: async (id: string): Promise<MemoryEntryDetail> => {
    const detail = await unwrap<unknown>(
      client.memory[':id'].$get({ param: { id } }),
    );
    return normalizeMemoryDetail(detail);
  },
  updateMemory: async (
    id: string,
    data: UpdateMemoryInput,
  ): Promise<MemoryEntry> => {
    const entry = await unwrap<unknown>(
      client.memory[':id'].$patch({ param: { id }, json: data }),
    );
    return normalizeMemoryEntry(entry);
  },
  deleteMemory: (id: string): Promise<{ deleted: string }> =>
    unwrap(client.memory[':id'].$delete({ param: { id } })),
  getMemoriesByInteraction: async (
    interactionId: string,
  ): Promise<MemoryEntry[]> => {
    const entries = await unwrap<unknown>(
      client.memory['by-interaction'][':interactionId'].$get({
        param: { interactionId },
      }),
    );
    return Array.isArray(entries)
      ? entries.map((entry) => normalizeMemoryEntry(entry))
      : [];
  },
  syncMemory: (): Promise<MemorySyncResult> =>
    unwrap(client.memory.sync.$post({})),
  refreshMemory: (entryId?: string): Promise<MemoryRefreshResult> =>
    unwrap(client.memory.refresh.$post({ json: { entryId } })),

  // Config
  getConfig: (): Promise<Config> => unwrap(client.config.$get()),
  updateConfig: async (cfgPatch: Partial<Config>): Promise<Config> => {
    const res = await fetch('/api/v1/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfgPatch),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Request failed' }));
      throw new Error((err as { error?: string }).error ?? 'Request failed');
    }
    return res.json();
  },
  getEmbeddingProviders: async (): Promise<
    Array<{ name: string; configFields: EmbeddingConfigField[] }>
  > => {
    const res = await fetch('/api/v1/config/embedding-providers');
    if (!res.ok) throw new Error('Failed to fetch embedding providers');
    return res.json();
  },

  // Models
  listModels: async (tool?: string): Promise<Record<string, ModelInfo[]>> => {
    const data = await unwrap<{ tools: Record<string, ModelInfo[]> }>(
      client.config.models.$get({ query: { tool } }),
    );
    return data.tools;
  },

  // Status
  getStatus: (): Promise<ProjectStatus> => unwrap(client.status.$get()),
  // Queue
  listQueue: (params?: {
    status?: string;
    taskId?: string;
    limit?: number;
  }): Promise<Job[]> =>
    unwrap(
      client.queue.$get({
        query: {
          status: params?.status,
          taskId: params?.taskId,
          limit: params?.limit != null ? String(params.limit) : undefined,
        },
      }),
    ),
  getQueueJob: (id: string): Promise<Job> =>
    unwrap(client.queue[':id'].$get({ param: { id } })),
  getQueueCounts: (): Promise<Record<string, number>> =>
    unwrap(client.queue.counts.$get()),
  cancelQueueJob: (id: string): Promise<{ cancelled: boolean }> =>
    unwrap(client.queue[':id'].$delete({ param: { id } })),
  drainQueue: (): Promise<{ cancelled: number }> =>
    unwrap(client.queue.$delete()),

  // Reset
  resetTask: async (
    taskId: string,
    interactionId: string,
    enqueue?: boolean,
  ): Promise<{
    taskId: string;
    resetToStep: string;
    commitSha?: string;
    status: string;
    enqueued: boolean;
  }> => {
    const res = await fetch(`/api/v1/tasks/${taskId}/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interactionId, enqueue }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Reset failed' }));
      throw new Error((err as { error?: string }).error ?? 'Reset failed');
    }
    return res.json();
  },
};
