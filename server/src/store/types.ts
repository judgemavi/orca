import type { MemoryCategory, MemorySourceType } from '../types/constants';
import type { Interaction } from '../types/models';

export interface MemoryEntryInput {
  id?: string;
  content: string;
  category: MemoryCategory;
  provenanceHash: string;
  tags?: string[];
  sourceType?: MemorySourceType;
  confidence?: number;
  coveredAtCommit?: string;
  stale?: boolean;
  decayExempt?: boolean;
  filePaths?: string[];
  sourceTaskId?: string;
  sourceInteractionId?: string;
  supersededBy?: string;
}

export type StoredInteraction = Interaction;

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
