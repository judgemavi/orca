import type {
  InteractionPhase,
  InteractionStatus,
  ReviewStatus,
  TaskStatus,
} from './lib/phases'

export interface Task {
  id: string
  title: string
  description: string
  parent_id: string | null
  status: TaskStatus
  depends_on: string[]
  plan: string | null
  created_at: string
  updated_at: string
}

export interface TaskReview {
  id: string
  task_id: string
  interaction_id?: string
  feedback: string
  status: ReviewStatus
  created_at: string
  addressed_at?: string
}

export interface Config {
  project: {
    name: string
    integration_branch: string
    worktree_dir: string
  }
  tools: string[]
  validation: { commands: string[] }
  workers: { max_parallel: number }
  orchestrator: {
    supervisor_tool: string
    supervisor_model: string
    phases: Record<string, { tool: string; model: string }>
  }
  monitor: {
    stuck_check_interval: string
    max_stuck_cycles: number
    conflict_check_interval: string
  }
  quality: {
    enabled: boolean
    scope_check: boolean
    test_delta: boolean
  }
  logging: { level: string; file: string; max_size: string }
}

export interface ModelInfo {
  id: string
  name: string
  provider: string
}

export interface Interaction {
  id: string
  task_id: string | null
  phase: InteractionPhase | string
  attempt: number
  tool: string
  status: InteractionStatus
  error?: string
  diff?: string
  exit_code?: number
  duration_ms?: number
  input_tokens: number
  output_tokens: number
  estimated_cost: number
  quality_json?: string
  started_at: string
  finished_at: string | null
}

export interface InteractionWithContent extends Interaction {
  content: string
}

export interface Operation {
  id: string
  type: string
  target_id: string
  status: InteractionStatus
  result?: string
  error?: string
  created_at: string
  updated_at: string
}

export interface AIReviewResult {
  task_id: string
  approved: boolean
  feedback: string
  tool: string
  prompt?: string
}

export interface TaskEvaluation {
  complexity?: string
  needs_breakdown: boolean
  confidence: number
  reasoning: string
  suggested_subtask_count: number
  description_hash?: string
}

interface WSEventBase<TType extends string, TData> {
  type: TType
  timestamp: string
  data: TData
}

export interface SessionEventData {
  id: string
  type: string
  tool: string
  task_id: string
  exit_code: number
  status?: string
}

export interface MergeFailedEventData {
  task_id?: string
  error: string
  conflict?: boolean
  worktree_path?: string
}

export interface MergeProgressEventData {
  task_id: string
  message?: string
  status?: string
  error?: string
}

export interface ProposedTask {
  title: string
  description: string
  depends_on_indices: number[]
  suggested_tool: string
}

export type MemoryCategory =
  | 'pattern'
  | 'pitfall'
  | 'preference'
  | 'convention'
  | 'architecture'
  | 'dependency'

export type MemorySourceType = 'retro' | 'explore'

export interface MemoryEntry {
  id: string
  content: string
  category: MemoryCategory
  tags: string[]
  confidence: number
  source_type: MemorySourceType
  file_paths?: string[]
  covered_at_commit?: string
  stale?: boolean
  source_task_id?: string
  source_interaction_id?: string
  provenance_hash: string
  superseded_by?: string
  created_at: string
  updated_at: string
}

export interface MemoryUsedByTask {
  task_id: string
  title: string
  status: string
}

export interface MemoryEntryDetail {
  entry: MemoryEntry
  used_by_tasks: MemoryUsedByTask[]
  supersedes?: string[]
}

export interface MemoryQueryResult {
  entry: MemoryEntry
  used_by_tasks: MemoryUsedByTask[]
}

export interface ListMemoryParams {
  category?: MemoryCategory
  tag?: string
  source_type?: MemorySourceType
  file_path?: string
  stale?: boolean
  covered_before?: string
  q?: string
  limit?: number
}

export interface UpdateMemoryInput {
  content?: string
  confidence?: number
  category?: MemoryCategory
}

export interface MemorySyncResult {
  last_commit: string
  new_commit: string
  commit_count: number
  affected_files: string[]
  flagged_entries: number
  stale_entries: number
  superseded_count: number
  classifications: Record<string, string>
  context_updated: boolean
  context_stale: boolean
}

export interface MemoryRefreshResult {
  entry_id?: string
  updated: number
  skipped: number
  commit: string
}

export interface ProjectStatus {
  project: string
  total_tasks: number
  pending: number
  in_progress: number
  completed: number
  failed: number
  context_exists: boolean
  context_stale: boolean
  context_age_minutes: number
  total_cost: number
  running_operations: number
  last_synced_commit: string
  current_commit: string
  sync_needed: boolean
  commits_behind: number
  memory_total: number
  memory_stale_count: number
}

export type KnownWSEvent =
  | WSEventBase<'task.created', Task>
  | WSEventBase<'task.updated', Task | { id: string }>
  | WSEventBase<'task.deleted', { id: string }>
  | WSEventBase<'config.updated', Config>
  | WSEventBase<'plan.generating', { task_id: string }>
  | WSEventBase<'plan.failed', { task_id: string; error: string }>
  | WSEventBase<'plan.completed', { task_id: string; plan: string }>
  | WSEventBase<'evaluate.started', { task_id: string }>
  | WSEventBase<
      'evaluate.completed',
      { task_id: string; evaluation: TaskEvaluation }
    >
  | WSEventBase<'evaluate.failed', { task_id: string; error: string }>
  | WSEventBase<'merge.started', { task_id?: string; mode?: string }>
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
      { task_id: string; stream: string; line: string; ts: string }
    >
  | WSEventBase<'worker.done', { task_id: string; exit_code: number }>
  | WSEventBase<'worker.output.end', { task_id: string; ts: string }>
  | WSEventBase<'run.failed', { error: string; task_ids?: string[] }>
  | WSEventBase<'run.completed', { results?: unknown; task_ids: string[] }>
  | WSEventBase<'cleanup.started', Record<string, never>>
  | WSEventBase<'cleanup.progress', { removed: string }>
  | WSEventBase<'cleanup.completed', { removed: number }>
  | WSEventBase<'explore.failed', { error: string }>
  | WSEventBase<'explore.completed', { path: string }>
  | WSEventBase<'ai_review.failed', { task_id: string; error: string }>
  | WSEventBase<'ai_review.completed', AIReviewResult>
  | WSEventBase<
      'breakdown.started',
      { task_id: string; session_id?: string; operation_id?: string }
    >
  | WSEventBase<
      'breakdown.failed',
      {
        task_id: string
        error: string
        session_id?: string
        operation_id?: string
      }
    >
  | WSEventBase<
      'breakdown.completed',
      {
        task_id: string
        proposed: ProposedTask[]
        interaction_id?: string
        session_id?: string
        operation_id?: string
      }
    >
  | WSEventBase<
      'breakdown.rejected',
      { task_id: string; interaction_id: string; rejected: boolean }
    >
  | WSEventBase<
      'monitor.alert',
      { type: string; task_id: string; message: string; timestamp: string }
    >

type KnownWSEventType = KnownWSEvent['type']

export type UnknownWSEvent = WSEventBase<string, Record<string, unknown>>

export type WSEvent = KnownWSEvent | UnknownWSEvent

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
])

function isKnownWSEventType(type: string): type is KnownWSEventType {
  return KNOWN_WS_EVENT_TYPES.has(type as KnownWSEventType)
}

export function isKnownWSEvent(event: WSEvent): event is KnownWSEvent {
  return isKnownWSEventType(event.type)
}
