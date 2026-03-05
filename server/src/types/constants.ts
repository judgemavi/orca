// Re-export constants from @orca/types (shared between server + web)
export {
  INTERACTION_STATUSES,
  type InteractionStatus,
  JOB_PRIORITIES,
  JOB_STATUSES,
  JOB_TYPES,
  type JobStatus,
  type JobType,
  REVIEW_STATUSES,
  type ReviewStatus,
  TASK_STATUSES,
  type TaskStatus,
} from '@orca/types';

// Domain enums not in DB schema
export type MemoryCategory =
  | 'pattern'
  | 'pitfall'
  | 'preference'
  | 'convention'
  | 'architecture'
  | 'dependency';

export type MemorySourceType = 'retro' | 'explore';
