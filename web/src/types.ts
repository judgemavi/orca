export interface Task {
  id: string
  title: string
  description: string
  parent_id: string | null
  status:
    | 'pending'
    | 'planned'
    | 'running'
    | 'stopped'
    | 'review'
    | 'approved'
    | 'merged'
    | 'failed'
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
  status: 'pending' | 'addressed'
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
  phase: string
  attempt: number
  tool: string
  status: 'running' | 'completed' | 'failed'
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
  status: 'running' | 'completed' | 'failed'
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
  | WSEventBase<'ai-review.failed', { task_id: string; error: string }>
  | WSEventBase<'ai-review.completed', AIReviewResult>
  | WSEventBase<'decompose.started', { session_id: string }>
  | WSEventBase<
      'decompose.failed',
      { error: string; session_id: string; operation_id?: string }
    >
  | WSEventBase<
      'decompose.completed',
      { proposed: ProposedTask[]; session_id: string; operation_id?: string }
    >
  | WSEventBase<
      'monitor_alert',
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
  'ai-review.failed',
  'ai-review.completed',
  'decompose.started',
  'decompose.failed',
  'decompose.completed',
  'monitor_alert',
])

function isKnownWSEventType(type: string): type is KnownWSEventType {
  return KNOWN_WS_EVENT_TYPES.has(type as KnownWSEventType)
}

export function isKnownWSEvent(event: WSEvent): event is KnownWSEvent {
  return isKnownWSEventType(event.type)
}
