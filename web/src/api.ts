import type { AppType } from '@orca/server';
import { hc } from 'hono/client';
import type {
  Config,
  EmbeddingConfigField,
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

const client = hc<AppType>('/api/v1');

type ApiError = Error & {
  conflict?: boolean;
  taskId?: string;
  worktreePath?: string;
};

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

function normalizePlanText(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (payload && typeof payload === 'object') {
    const p = (payload as { plan?: unknown }).plan;
    if (typeof p === 'string') return p;
  }
  return '';
}

export const api = {
  // Tasks
  listTasks: (): Promise<Task[]> => unwrap(client.tasks.$get()),
  getTask: (id: string): Promise<Task> =>
    unwrap(client.tasks[':id'].$get({ param: { id } })),
  createTask: (data: Pick<Task, 'title'> & Partial<Task>): Promise<Task> =>
    unwrap(client.tasks.$post({ json: data })),
  updateTask: (
    id: string,
    data: Partial<Task> & { sessionId?: string | null },
  ): Promise<Task> =>
    unwrap(client.tasks[':id'].$patch({ param: { id }, json: data })),
  deleteTask: (id: string): Promise<{ deleted: string }> =>
    unwrap(client.tasks[':id'].$delete({ param: { id } })),
  getTaskReviews: (id: string): Promise<TaskReview[]> =>
    unwrap(client.tasks[':id'].reviews.$get({ param: { id } })),

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
  listInteractionStubs: (taskId: string): Promise<InteractionStub[]> =>
    unwrap(
      client.tasks[':id'].interactions.$get({
        param: { id: taskId },
      }),
    ),
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

  // Run / Start / Stop
  startTasks: (
    taskIds?: string[],
    tool?: string,
    model?: string,
  ): Promise<{ status: string; taskIds: string[]; jobIds: string[] }> =>
    unwrap(client.tasks.start.$post({ json: { taskIds, tool, model } })),
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
  cancelTask: (id: string): Promise<{ taskId: string; status: string }> =>
    unwrap(client.tasks[':id'].cancel.$post({ param: { id } })),

  // Merge (global merge removed — use mergeTask per task)
  mergeTask: (
    taskId: string,
    mode?: string,
  ): Promise<{ jobId: string; taskId: string; status: string }> =>
    unwrap(
      client.tasks[':id'].merge.$post({
        param: { id: taskId },
        json: { mode },
      }),
    ),

  // Plan
  getTaskPlan: async (taskId: string): Promise<string> =>
    normalizePlanText(
      await unwrap(client.tasks[':id'].plan.$get({ param: { id: taskId } })),
    ),
  saveTaskPlan: (taskId: string, plan: string): Promise<{ plan: string }> =>
    unwrap(
      client.tasks[':id'].plan.$put({
        param: { id: taskId },
        json: { plan },
      }),
    ),
  generateTaskPlan: (
    taskId: string,
    opts?: { tool?: string; model?: string },
  ): Promise<{ status: string }> =>
    unwrap(
      client.tasks[':id'].plan.generate.$post({
        param: { id: taskId },
        json: opts ?? {},
      }),
    ),
  approvePlan: (id: string): Promise<Task> =>
    unwrap(client.tasks[':id']['approve-plan'].$post({ param: { id } })),
  requestPlanChanges: (
    id: string,
    feedback: string,
    interactionId?: string,
    tool?: string,
    model?: string,
  ): Promise<{ status: string }> =>
    unwrap(
      client.tasks[':id']['request-plan-changes'].$post({
        param: { id },
        json: { feedback, interactionId, tool, model },
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
  aiReview: (
    id: string,
    tool?: string,
    model?: string,
    prompt?: string,
  ): Promise<{ status: string; taskId: string }> =>
    unwrap(
      client.tasks[':id']['ai-review'].$post({
        param: { id },
        json: { tool, model, prompt },
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

  // Explore (moved under memory)
  runExplore: (): Promise<{ status: string }> =>
    unwrap(client.memory.explore.$post({ json: {} })),

  // Memory
  listMemory: (params?: ListMemoryParams): Promise<MemoryEntry[]> =>
    unwrap(
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
    ),
  queryMemory: (q: string, limit?: number): Promise<MemoryQueryResult[]> =>
    unwrap(
      client.memory.query.$get({
        query: {
          q,
          limit: typeof limit === 'number' ? String(limit) : undefined,
        },
      }),
    ),
  getMemory: (id: string): Promise<MemoryEntryDetail> =>
    unwrap(client.memory[':id'].$get({ param: { id } })),
  updateMemory: (id: string, data: UpdateMemoryInput): Promise<MemoryEntry> =>
    unwrap(client.memory[':id'].$patch({ param: { id }, json: data })),
  deleteMemory: (id: string): Promise<{ deleted: string }> =>
    unwrap(client.memory[':id'].$delete({ param: { id } })),
  getMemoriesByInteraction: (interactionId: string): Promise<MemoryEntry[]> =>
    unwrap(
      client.memory['by-interaction'][':interactionId'].$get({
        param: { interactionId },
      }),
    ),
  syncMemory: (): Promise<MemorySyncResult> =>
    unwrap(client.memory.sync.$post({})),
  refreshMemory: (entryId?: string): Promise<MemoryRefreshResult> =>
    unwrap(client.memory.refresh.$post({ json: { entryId } })),

  // Config
  getConfig: (): Promise<Config> => unwrap(client.config.$get()),
  updateConfig: (cfgPatch: Partial<Config>): Promise<Config> =>
    unwrap(client.config.$put({ json: cfgPatch })),
  getEmbeddingProviders: (): Promise<
    Array<{ name: string; configFields: EmbeddingConfigField[] }>
  > => unwrap(client.config['embedding-providers'].$get()),

  // Models
  listModels: async (tool?: string): Promise<Record<string, ModelInfo[]>> => {
    const data = await unwrap<{ tools: Record<string, ModelInfo[]> }>(
      client.config.models.$get({ query: { tool } }),
    );
    return data.tools;
  },

  // Status
  getStatus: (): Promise<ProjectStatus> => unwrap(client.status.$get()),

  // Sessions
  listSessions: (): Promise<
    Array<{
      id: string;
      type: string;
      tool: string;
      taskId: string;
      cols: number;
      rows: number;
      createdAt: string;
    }>
  > => unwrap(client.sessions.$get()),

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
};
