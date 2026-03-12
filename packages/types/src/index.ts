export const INTERACTION_STATUSES = {
  running: 'running',
  completed: 'completed',
  failed: 'failed',
} as const;

export type InteractionStatus =
  (typeof INTERACTION_STATUSES)[keyof typeof INTERACTION_STATUSES];

export const TASK_STATUSES = {
  pending: 'pending',
  planned: 'planned',
  running: 'running',
  stopped: 'stopped',
  review: 'review',
  approved: 'approved',
  broken_down: 'broken_down',
  merged: 'merged',
  failed: 'failed',
} as const;

export type TaskStatus = (typeof TASK_STATUSES)[keyof typeof TASK_STATUSES];

export const JOB_STATUSES = {
  queued: 'queued',
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
} as const;

export type JobStatus = (typeof JOB_STATUSES)[keyof typeof JOB_STATUSES];

export const SYSTEM_JOB_TYPES = {
  evaluate: 'evaluate',
  breakdown: 'breakdown',
  explore: 'explore',
  retro: 'retro',
} as const;

export type SystemJobType =
  (typeof SYSTEM_JOB_TYPES)[keyof typeof SYSTEM_JOB_TYPES];

export const SYSTEM_JOB_PRIORITIES: Record<SystemJobType, number> = {
  evaluate: 3,
  breakdown: 4,
  explore: 5,
  retro: 6,
};
