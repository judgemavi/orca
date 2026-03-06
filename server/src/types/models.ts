import type {
  interactions,
  jobs,
  memoryEntries,
  taskInteractions,
  taskReviews,
  tasks,
} from '../db/schema';
import type { AutoRunOverrides } from './api';
import type {
  InteractionStatus,
  JobStatus,
  JobType,
  MemoryCategory,
  MemorySourceType,
  ReviewStatus,
  TaskStatus,
} from './constants';

// -- Drizzle row types (private, not exported) --
type TaskRow = typeof tasks.$inferSelect;
type InteractionRow = typeof taskInteractions.$inferSelect;
type ReviewRow = typeof taskReviews.$inferSelect;
type JobRow = typeof jobs.$inferSelect;
type MemoryRow = typeof memoryEntries.$inferSelect;
type OperationRow = typeof interactions.$inferSelect;

// -- API types (row + narrowed enums + computed fields) --

export type Task = Omit<TaskRow, 'status' | 'autoRunOverrides'> & {
  status: TaskStatus;
  dependsOn: string[];
  autoRunOverrides?: AutoRunOverrides;
};

export type Interaction = Omit<
  InteractionRow,
  'status' | 'error' | 'diff' | 'exitCode' | 'durationMs' | 'qualityJson'
> & {
  status: InteractionStatus;
  error?: string;
  diff?: string;
  exitCode?: number;
  durationMs?: number;
  qualityJson?: string;
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
  | 'estimatedCost'
  | 'startedAt'
  | 'finishedAt'
> & {
  diffSummary?: string | null;
};

export interface InteractionWithContent extends Interaction {
  content: string;
  rawContent?: string;
}

export type TaskReview = Omit<
  ReviewRow,
  'status' | 'interactionId' | 'addressedAt'
> & {
  status: ReviewStatus;
  interactionId?: string;
  addressedAt?: string;
};

export type Job = Omit<
  JobRow,
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
  MemoryRow,
  | 'category'
  | 'tags'
  | 'sourceType'
  | 'stale'
  | 'confidence'
  | 'sourceTaskId'
  | 'sourceInteractionId'
  | 'supersededBy'
  | 'coveredAtCommit'
> & {
  category: MemoryCategory;
  tags: string[];
  sourceType: MemorySourceType;
  stale: boolean;
  confidence: number;
  filePaths?: string[];
  sourceTaskId?: string;
  sourceInteractionId?: string;
  supersededBy?: string;
  coveredAtCommit?: string;
};

export type Operation = Omit<OperationRow, 'status' | 'result' | 'error'> & {
  status: InteractionStatus;
  result?: string;
  error?: string;
};
