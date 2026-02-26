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

export interface AIReviewResult {
  task_id: string
  approved: boolean
  feedback: string
  tool: string
  prompt?: string
}

export interface TaskEvaluation {
  should_decompose: boolean
  complexity: string
  reasoning: string
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

export interface WSEvent {
  type: string
  timestamp: string
  data: Record<string, unknown>
}
