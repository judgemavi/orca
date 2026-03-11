import type { MemoryCategory, MemorySourceType } from './constants';
import type { MemoryEntry } from './models';
// System interaction types — not workflow steps, system-controlled
export const SYSTEM_INTERACTION_TYPES = [
  'evaluate',
  'breakdown',
  'merge',
  'retro',
  'explore',
] as const;
export type SystemInteractionType = (typeof SYSTEM_INTERACTION_TYPES)[number];

export type AutoRunOverrides = Record<string, boolean>;

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
}

export interface ProposedTask {
  title: string;
  description: string;
  dependsOnIndices: number[];
  suggestedTool: string;
}

export interface TaskEvaluation {
  complexity?: string;
  needsBreakdown: boolean;
  confidence: number;
  reasoning: string;
  suggestedSubtaskCount: number;
  descriptionHash?: string;
  needsUserInput?: boolean;
  userInputQuestion?: string;
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
  runningOperations: number;
  lastSyncedCommit: string;
  currentCommit: string;
  syncNeeded: boolean;
  commitsBehind: number;
  memoryTotal: number;
  memoryStaleCount: number;
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
  score: number;
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
