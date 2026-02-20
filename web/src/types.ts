export interface Task {
  id: string
  title: string
  description: string
  prompt: string
  parent_id: string | null
  status:
    | 'pending'
    | 'in_sprint'
    | 'running'
    | 'completed'
    | 'merged'
    | 'failed'
  assigned_tool: string | null
  sprint_id: string | null
  depends_on: string[]
  model: string | null
  plan: string | null
  created_at: string
  updated_at: string
}

export interface Sprint {
  id: string
  status: 'planning' | 'running' | 'completed' | 'failed'
  task_ids: string[]
  created_at: string
  completed_at: string | null
}

export interface Config {
  project: {
    name: string
    integration_branch: string
    worktree_dir: string
  }
  tools: Record<
    string,
    {
      binary: string
      mode: string
      timeout: string
      model?: string
    }
  >
  workers: { max_parallel: number }
  autopilot: {
    enabled: boolean
    cost_budget: number
    max_sprints: number
    pause_on_review: boolean
  }
}

export interface ModelInfo {
  id: string
  name: string
  provider: string
}

export interface ReviewArtifact {
  task_id: string
  title: string
  status: string
  diff: string
  files: string[]
  duration_ms: number
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

export interface ProjectStatus {
  project_name: string
  task_counts: Record<string, number>
  active_sprint: { id: string; status: string } | null
  context_exists: boolean
  total_cost: number
  budget: number
  budget_remaining: number
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  timestamp: string
  content?: string
  blocks?: Block[]
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
      type: 'sprint_progress'
      data: { sprint_id: string; tasks: SprintTaskStatus[] }
    }
  | {
      type: 'sprint_result'
      data: {
        sprint_id: string
        results: TaskResultSummary[]
        actions: string[]
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
      type: 'integrate_result'
      data: { merged: TaskSummary[]; failed: TaskSummary[] }
    }
  | { type: 'help'; data: { commands: CommandHelp[] } }

export interface SprintTaskStatus {
  task_id: string
  title: string
  tool_name: string
  status: string
  duration_ms: number
  progress_pct: number
}

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

export interface LogEntry {
  task_id: string
  size_bytes: number
  modified_at: string
  task_title?: string
  task_status?: Task['status']
}
