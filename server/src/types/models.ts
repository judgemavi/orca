import type {
  InteractionStatus,
  JobStatus,
  JobType,
  TaskStatus,
} from '@orca/types';
import type {
  MemoryEntry as DBMemoryEntry,
  InteractionEntry,
  JobEntry,
  TaskEntry,
} from '../db/schema';
import type { AutoRunOverrides } from './api';
import type { MemoryCategory, MemorySourceType } from './constants';

export type Task = Omit<
  TaskEntry,
  'status' | 'autoRunOverrides' | 'dependsOn'
> & {
  status: TaskStatus;
  dependsOn: string[];
  autoRunOverrides?: AutoRunOverrides;
};

export type Interaction = Omit<
  InteractionEntry,
  'status' | 'error' | 'exitCode' | 'durationMs'
> & {
  status: InteractionStatus;
  error?: string;
  exitCode?: number;
  durationMs?: number;
};

export type InteractionStub = Pick<
  Interaction,
  | 'id'
  | 'taskId'
  | 'type'
  | 'attempt'
  | 'tool'
  | 'status'
  | 'durationMs'
  | 'startedAt'
  | 'finishedAt'
> & {
  stepName?: string;
  diffSummary?: string | null;
  memoryCount?: number;
  previousInteractionId?: string;
  commitSha?: string;
  sessionId?: string;
};

export interface InteractionWithContent extends Interaction {
  content: string;
  rawContent?: string;
}

export type Job = Omit<
  JobEntry,
  'type' | 'status' | 'payload' | 'result' | 'startedAt' | 'completedAt'
> & {
  type: JobType;
  status: JobStatus;
  payload: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  startedAt: string | null;
  completedAt: string | null;
};

export type MemoryEntry = Omit<
  DBMemoryEntry,
  | 'category'
  | 'tags'
  | 'sourceType'
  | 'stale'
  | 'confidence'
  | 'sourceTaskId'
  | 'sourceInteractionId'
  | 'supersededBy'
  | 'coveredAtCommit'
  | 'embedding'
  | 'retrievalCount'
  | 'decayExempt'
> & {
  category: MemoryCategory;
  tags: string[];
  sourceType: MemorySourceType;
  stale: boolean;
  confidence: number;
  retrievalCount: number;
  decayExempt: boolean;
  filePaths?: string[];
  sourceTaskId?: string;
  sourceInteractionId?: string;
  supersededBy?: string;
  coveredAtCommit?: string;
};
