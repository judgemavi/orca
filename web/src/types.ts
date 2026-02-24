export interface Task {
  id: string
  title: string
  description: string
  parent_id: string | null
  status:
    | 'pending'
    | 'planned'
    | 'running'
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

export interface PhaseOverride {
  tool?: string
  model?: string
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
    cost_budget: number
    task_budget: number
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

export interface TaskResult {
  task_id: string
  tool_name: string
  status: 'completed' | 'failed'
  exit_code: number
  diff: string
  files_changed: string[]
  stdout: string
  stderr: string
  duration_ms: number
  worktree_path: string
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

export interface ProposedTask {
  title: string
  description: string
  depends_on_indices: number[]
  suggested_tool: string
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

export interface ToolSummary {
  tool: string
  input_tokens: number
  output_tokens: number
  cost: number
}

export interface ReviewResult {
  task_id: string
  approved: boolean
  feedback: string
  tool: string
}

export interface AIReviewResult {
  task_id: string
  approved: boolean
  feedback: string
  tool: string
}

export interface ProjectStatus {
  project_name: string
  task_counts: Record<string, number>
  context_exists: boolean
  context_stale?: boolean
  context_age_minutes?: number
  total_cost: number
  budget: number
  budget_remaining: number
}

export interface QualityScope {
  task_id: string
  files_changed: number
  lines_changed: number
  flags: string[]
  excessive: boolean
}

export interface QualityTestDelta {
  new_failures: string[]
  new_passes: string[]
  unchanged: string[]
  test_count_delta: number
}

export interface QualityResult {
  scope?: QualityScope
  test_delta?: QualityTestDelta
}

export interface MonitorAlert {
  type: 'stuck' | 'budget' | 'conflict'
  task_id: string
  message: string
  timestamp: string
}

export interface WorktreeInfo {
  task_id: string
  branch: string
  age_hours: number
}

export interface WorktreeStatus {
  worktrees: WorktreeInfo[]
  total_disk_bytes: number
}

export interface PTYSession {
  id: string
  type: 'orchestrator' | 'worker'
  tool: string
  task_id: string
  cols: number
  rows: number
  created_at: string
}

export type Block =
  | { type: 'text'; data: { content: string } }
  | { type: 'task_card'; data: { task: Task; actions: string[] } }
  | { type: 'task_list'; data: { tasks: Task[]; actions: string[] } }
  | {
      type: 'plan_proposal'
      data: {
        goal: string
        proposed_tasks: ProposedTask[]
        actions: string[]
        session_id?: string
        proposal_id?: string
        operation_id?: string
      }
    }
  | {
      type: 'diff_viewer'
      data: {
        task_id: string
        title: string
        diff: string
        files_changed: string[]
        actions: string[]
      }
    }
  | {
      type: 'review_result'
      data: { reviews: ReviewResultDisplay[]; actions: string[] }
    }
  | {
      type: 'cost_card'
      data: {
        scope: string
        total: number
        budget: number
        remaining: number
        tools: ToolSummary[]
      }
    }
  | { type: 'status_card'; data: ProjectStatus }
  | {
      type: 'escalation'
      data: { message: string; task_id: string; actions: string[] }
    }
  | {
      type: 'merge_result'
      data: { merged: TaskSummary[]; failed: TaskSummary[] }
    }
  | { type: 'help'; data: { commands: CommandHelp[] } }

export interface TaskResultSummary {
  task_id: string
  title: string
  status: string
  tool_name: string
  duration_ms: number
  files_changed: string[]
  diff_preview: string
  has_full_diff: boolean
}

export interface ReviewResultDisplay {
  task_id: string
  title: string
  approved: boolean
  feedback: string
  tool: string
}

export interface TaskSummary {
  task_id: string
  title: string
}

export interface CommandHelp {
  command: string
  description: string
}

export interface WSEvent {
  type: string
  timestamp: string
  data: Record<string, unknown>
}

export interface WorkerOutputEvent {
  task_id: string
  stream: 'stdout' | 'stderr'
  line: string
  ts: string
}
