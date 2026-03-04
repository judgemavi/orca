import type {
  Config,
  Interaction,
  MemoryCategory,
  MemoryEntry,
  MemoryUsedByTask,
  MemorySourceType,
  TaskStatus,
} from '../types'

export interface TaskCreateInput {
  id?: string
  title: string
  description?: string
  parentId?: string | null
}

export interface TaskUpdateFields {
  title?: string
  description?: string
  plan?: string | null
  status?: TaskStatus
  sessionId?: string | null
}

export interface InteractionBeginInput {
  taskId?: string | null
  phase: string
  tool: string
}

export interface InteractionFinishFields {
  status: string
  error?: string | null
  diff?: string | null
  exitCode?: number
  durationMs?: number
  qualityJson?: string | null
  inputTokens?: number
  outputTokens?: number
  estimatedCost?: number
  runId?: string | null
  model?: string | null
}

export interface StoredInteraction extends Interaction {
  runId?: string | null
  model?: string | null
  logPath: string
}

export interface ToolSummary {
  tool: string
  inputTokens: number
  outputTokens: number
  cost: number
}

export interface ConfigRow {
  key: string
  value: Config
}

export interface MemoryHealthSummary {
  totalEntries: number
  bySource: Record<MemorySourceType, number>
  staleCount: number
  avgConfidence: number
}

export interface MemoryListOptions {
  category?: MemoryCategory
  tag?: string
  sourceType?: MemorySourceType
  filePath?: string
  staleOnly?: boolean
  coveredBefore?: string
}

export interface MemoryUpdateFields {
  content?: string
  category?: MemoryCategory
  confidence?: number
  sourceType?: MemorySourceType
  stale?: boolean
  coveredAtCommit?: string
  tags?: string[]
}

export interface MemoryEntryInput {
  id?: string
  content: string
  category: MemoryCategory
  tags?: string[]
  sourceTaskId?: string
  sourceInteractionId?: string
  sourceType?: MemorySourceType
  filePaths?: string[]
  coveredAtCommit?: string
  stale?: boolean
  confidence?: number
  provenanceHash: string
  supersededBy?: string
}

export interface MemorySearchResult {
  entry: MemoryEntry
  usedByTasks: MemoryUsedByTask[]
}

export interface LogQueryFilter {
  level?: string
  taskId?: string
  since?: Date
  pattern?: string
  limit?: number
}

export interface LogEntry {
  time: Date
  level: string
  msg: string
  attrs?: Record<string, unknown>
}
