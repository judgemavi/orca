export const INTERACTION_STATUSES = {
  running: 'running',
  completed: 'completed',
  failed: 'failed',
} as const;

export type InteractionStatus =
  (typeof INTERACTION_STATUSES)[keyof typeof INTERACTION_STATUSES];

export const TASK_STATUSES = {
  pending: 'pending',
  planned: 'planned',
  running: 'running',
  stopped: 'stopped',
  review: 'review',
  approved: 'approved',
  broken_down: 'broken_down',
  merged: 'merged',
  failed: 'failed',
} as const;

export type TaskStatus = (typeof TASK_STATUSES)[keyof typeof TASK_STATUSES];

export const REVIEW_STATUSES = {
  pending: 'pending',
  addressed: 'addressed',
} as const;

export type ReviewStatus =
  (typeof REVIEW_STATUSES)[keyof typeof REVIEW_STATUSES];

export interface Task {
  id: string;
  title: string;
  description: string;
  parentId: string | null;
  sessionId?: string;
  status: TaskStatus;
  dependsOn: string[];
  plan: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskReview {
  id: string;
  taskId: string;
  interactionId?: string;
  feedback: string;
  status: ReviewStatus;
  createdAt: string;
  addressedAt?: string;
}

export interface Config {
  project: {
    name: string;
    integrationBranch: string;
    worktreeDir: string;
  };
  tools: string[];
  defaultTool: string;
  defaultModel: string;
  validation: { commands: string[] };
  workers: { maxParallel: number };
  orchestrator: {
    supervisorTool: string;
    supervisorModel: string;
    overrides: Record<string, { tool: string; model: string }>;
  };
  monitor: {
    stuckCheckInterval: import('ms').StringValue;
    maxStuckCycles: number;
    conflictCheckInterval: import('ms').StringValue;
  };
  quality: {
    enabled: boolean;
    scopeCheck: boolean;
    testDelta: boolean;
    llmAlignment?: boolean;
  };
  postMerge?: {
    enabled?: boolean;
    retro?: boolean;
    memorySync?: boolean;
  };
  cost?: {
    budgetUsd?: number;
  };
  logging: { level: string; file: string; maxSize: string };
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
}

export interface Interaction {
  id: string;
  taskId: string | null;
  type: string;
  attempt: number;
  tool: string;
  status: InteractionStatus;
  error?: string;
  diff?: string;
  exitCode?: number;
  durationMs?: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
  qualityJson?: string;
  startedAt: string;
  finishedAt: string | null;
}

export interface InteractionStub {
  id: string;
  taskId: string | null;
  type: string;
  attempt: number;
  tool: string;
  status: InteractionStatus;
  durationMs?: number;
  estimatedCost: number;
  diffSummary?: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface InteractionWithContent extends Interaction {
  content: string;
  rawContent?: string;
}

export interface OrchestratorMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'tool_use' | 'tool_result';
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface OrchestratorSessionSummary {
  id: string;
  tool: string;
  model: string;
  status: string;
  createdAt: string;
  messageCount: number;
  preview: string | null;
}

export interface Operation {
  id: string;
  type: string;
  targetId: string;
  status: InteractionStatus;
  result?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AIReviewCheck {
  key: string;
  label: string;
  passed: boolean;
}

export interface AIReviewFinding {
  id: string;
  summary: string;
  detail: string;
  passed: boolean;
  filePath?: string;
  line?: number;
}

export interface AIReviewResult {
  taskId: string;
  approved: boolean;
  feedback: string;
  tool: string;
  prompt?: string;
  checks?: AIReviewCheck[];
  findings?: AIReviewFinding[];
}

export interface TaskEvaluation {
  complexity?: string;
  needsBreakdown: boolean;
  confidence: number;
  reasoning: string;
  suggestedSubtaskCount: number;
  descriptionHash?: string;
}

interface WSEventBase<TType extends string, TData> {
  type: TType;
  timestamp: string;
  data: TData;
}

export interface SessionEventData {
  id: string;
  type: string;
  tool: string;
  taskId: string;
  exitCode: number;
  status?: string;
}

export interface MergeFailedEventData {
  taskId?: string;
  error: string;
  conflict?: boolean;
  worktreePath?: string;
}

export interface MergeProgressEventData {
  taskId: string;
  message?: string;
  status?: string;
  error?: string;
}

export interface ProposedTask {
  title: string;
  description: string;
  dependsOnIndices: number[];
  suggestedTool: string;
}

export type MemoryCategory =
  | 'pattern'
  | 'pitfall'
  | 'preference'
  | 'convention'
  | 'architecture'
  | 'dependency';

export type MemorySourceType = 'retro' | 'explore';

export interface MemoryEntry {
  id: string;
  content: string;
  category: MemoryCategory;
  tags: string[];
  confidence: number;
  sourceType: MemorySourceType;
  filePaths?: string[];
  coveredAtCommit?: string;
  stale?: boolean;
  sourceTaskId?: string;
  sourceInteractionId?: string;
  provenanceHash: string;
  supersededBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryUsedByTask {
  taskId: string;
  title: string;
  status: string;
}

export interface MemoryEntryDetail {
  entry: MemoryEntry;
  usedByTasks: MemoryUsedByTask[];
  supersedes?: string[];
}

export interface MemoryQueryResult {
  entry: MemoryEntry;
  usedByTasks: MemoryUsedByTask[];
}

export interface ListMemoryParams {
  category?: MemoryCategory;
  tag?: string;
  sourceType?: MemorySourceType;
  filePath?: string;
  stale?: boolean;
  coveredBefore?: string;
  q?: string;
  limit?: number;
}

export interface UpdateMemoryInput {
  content?: string;
  confidence?: number;
  category?: MemoryCategory;
}

export interface MemorySyncResult {
  lastCommit: string;
  newCommit: string;
  commitCount: number;
  affectedFiles: string[];
  flaggedEntries: number;
  staleEntries: number;
  supersededCount: number;
  classifications: Record<string, string>;
  contextUpdated: boolean;
  contextStale: boolean;
}

export interface MemoryRefreshResult {
  entryId?: string;
  updated: number;
  skipped: number;
  commit: string;
}

export interface ProjectStatus {
  project: string;
  totalTasks: number;
  pending: number;
  inProgress: number;
  completed: number;
  failed: number;
  contextExists: boolean;
  contextStale: boolean;
  contextAgeMinutes: number;
  totalCost: number;
  runningOperations: number;
  lastSyncedCommit: string;
  currentCommit: string;
  syncNeeded: boolean;
  commitsBehind: number;
  memoryTotal: number;
  memoryStaleCount: number;
}

export const JOB_STATUSES = {
  queued: 'queued',
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
} as const;

export type JobStatus = (typeof JOB_STATUSES)[keyof typeof JOB_STATUSES];

export const JOB_TYPES = {
  run: 'run',
  evaluate: 'evaluate',
  plan: 'plan',
  breakdown: 'breakdown',
  review: 'review',
  explore: 'explore',
  merge: 'merge',
} as const;

export type JobType = (typeof JOB_TYPES)[keyof typeof JOB_TYPES];

export const JOB_PRIORITIES: Record<JobType, number> = {
  run: 0,
  review: 1,
  merge: 2,
  evaluate: 3,
  plan: 4,
  breakdown: 4,
  explore: 5,
};

export interface Job {
  id: string;
  type: JobType;
  taskId: string | null;
  status: JobStatus;
  priority: number;
  payload: Record<string, unknown> | null;
  error: string | null;
  result: Record<string, unknown> | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export type KnownWSEvent =
  | WSEventBase<'task.created', Task>
  | WSEventBase<'task.updated', Task | { id: string }>
  | WSEventBase<'task.deleted', { id: string }>
  | WSEventBase<'config.updated', Config>
  | WSEventBase<'plan.generating', { taskId: string }>
  | WSEventBase<'plan.failed', { taskId: string; error: string }>
  | WSEventBase<'plan.completed', { taskId: string; plan: string }>
  | WSEventBase<'evaluate.started', { taskId: string }>
  | WSEventBase<
      'evaluate.completed',
      { taskId: string; evaluation: TaskEvaluation }
    >
  | WSEventBase<'evaluate.failed', { taskId: string; error: string }>
  | WSEventBase<'merge.started', { taskId?: string; mode?: string }>
  | WSEventBase<'merge.progress', MergeProgressEventData>
  | WSEventBase<'merge.failed', MergeFailedEventData>
  | WSEventBase<
      'merge.completed',
      Task | { merged: string[]; failed: string[] }
    >
  | WSEventBase<'interaction.started', Interaction | { id: string }>
  | WSEventBase<'interaction.updated', Interaction | { id: string }>
  | WSEventBase<'interaction.completed', Interaction | { id: string }>
  | WSEventBase<'interaction.failed', Interaction | { id: string }>
  | WSEventBase<'session.created', SessionEventData>
  | WSEventBase<'session.exited', SessionEventData>
  | WSEventBase<
      'worker.output',
      { taskId: string; stream: string; line: string; ts: string }
    >
  | WSEventBase<'worker.done', { taskId: string; exitCode: number }>
  | WSEventBase<'worker.output.end', { taskId: string; ts: string }>
  | WSEventBase<'run.failed', { error: string; taskIds?: string[] }>
  | WSEventBase<'run.completed', { results?: unknown; taskIds: string[] }>
  | WSEventBase<'cleanup.started', Record<string, never>>
  | WSEventBase<'cleanup.progress', { removed: string }>
  | WSEventBase<'cleanup.completed', { removed: number }>
  | WSEventBase<'explore.failed', { error: string }>
  | WSEventBase<'explore.completed', { path: string }>
  | WSEventBase<'ai_review.failed', { taskId: string; error: string }>
  | WSEventBase<'ai_review.completed', AIReviewResult>
  | WSEventBase<
      'breakdown.started',
      { taskId: string; sessionId?: string; operationId?: string }
    >
  | WSEventBase<
      'breakdown.failed',
      {
        taskId: string;
        error: string;
        sessionId?: string;
        operationId?: string;
      }
    >
  | WSEventBase<
      'breakdown.completed',
      {
        taskId: string;
        proposed: ProposedTask[];
        interactionId?: string;
        sessionId?: string;
        operationId?: string;
      }
    >
  | WSEventBase<
      'breakdown.rejected',
      { taskId: string; interactionId: string; rejected: boolean }
    >
  | WSEventBase<
      'monitor.alert',
      { type: string; taskId: string; message: string; timestamp: string }
    >
  | WSEventBase<'monitor.conflict', { taskIds: string[]; files: string[] }>
  | WSEventBase<'monitor.stuck', { taskId: string; message: string }>
  | WSEventBase<'quality.alert', { taskId: string; issues: string[] }>
  | WSEventBase<
      'queue.job.queued',
      { jobId: string; type: string; taskId?: string; priority: number }
    >
  | WSEventBase<
      'queue.job.started',
      { jobId: string; type: string; taskId?: string }
    >
  | WSEventBase<
      'queue.job.completed',
      { jobId: string; type: string; taskId?: string }
    >
  | WSEventBase<
      'queue.job.failed',
      { jobId: string; type: string; taskId?: string; error: string }
    >
  | WSEventBase<
      'queue.job.cancelled',
      { jobId: string; type: string; taskId?: string }
    >;

type KnownWSEventType = KnownWSEvent['type'];

export type UnknownWSEvent = WSEventBase<string, Record<string, unknown>>;

export type WSEvent = KnownWSEvent | UnknownWSEvent;

const KNOWN_WS_EVENT_TYPES = new Set<KnownWSEventType>([
  'task.created',
  'task.updated',
  'task.deleted',
  'config.updated',
  'plan.generating',
  'plan.failed',
  'plan.completed',
  'evaluate.started',
  'evaluate.completed',
  'evaluate.failed',
  'merge.started',
  'merge.progress',
  'merge.failed',
  'merge.completed',
  'interaction.started',
  'interaction.updated',
  'interaction.completed',
  'interaction.failed',
  'session.created',
  'session.exited',
  'worker.output',
  'worker.done',
  'worker.output.end',
  'run.failed',
  'run.completed',
  'cleanup.started',
  'cleanup.progress',
  'cleanup.completed',
  'explore.failed',
  'explore.completed',
  'ai_review.failed',
  'ai_review.completed',
  'breakdown.started',
  'breakdown.failed',
  'breakdown.completed',
  'breakdown.rejected',
  'monitor.alert',
  'queue.job.queued',
  'queue.job.started',
  'queue.job.completed',
  'queue.job.failed',
  'queue.job.cancelled',
]);

function isKnownWSEventType(type: string): type is KnownWSEventType {
  return KNOWN_WS_EVENT_TYPES.has(type as KnownWSEventType);
}

export function isKnownWSEvent(event: WSEvent): event is KnownWSEvent {
  return isKnownWSEventType(event.type);
}
