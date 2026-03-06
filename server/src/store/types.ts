import type {
  AutoRunOverrides,
  Interaction,
  MemoryCategory,
  MemorySourceType,
  TaskStatus,
} from '../types';

export interface TaskCreateInput {
  id?: string;
  title: string;
  description?: string;
  parentId?: string | null;
  autoRunOverrides?: AutoRunOverrides;
}

export interface TaskUpdateFields {
  title?: string;
  description?: string;
  plan?: string | null;
  status?: TaskStatus;
  sessionId?: string | null;
  autoRunOverrides?: AutoRunOverrides;
}

export type StoredInteraction = Interaction;

export interface ToolSummary {
  tool: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}
export interface MemoryHealthSummary {
  totalEntries: number;
  bySource: Record<MemorySourceType, number>;
  staleCount: number;
  avgConfidence: number;
}

export interface MemoryListOptions {
  category?: MemoryCategory;
  tag?: string;
  sourceType?: MemorySourceType;
  filePath?: string;
  staleOnly?: boolean;
  coveredBefore?: string;
}

export interface MemoryUpdateFields {
  content?: string;
  category?: MemoryCategory;
  confidence?: number;
  sourceType?: MemorySourceType;
  stale?: boolean;
  coveredAtCommit?: string;
  tags?: string[];
}

export interface MemoryEntryInput {
  id?: string;
  content: string;
  category: MemoryCategory;
  tags?: string[];
  sourceTaskId?: string;
  sourceInteractionId?: string;
  sourceType?: MemorySourceType;
  filePaths?: string[];
  coveredAtCommit?: string;
  stale?: boolean;
  confidence?: number;
  provenanceHash: string;
  supersededBy?: string;
}
