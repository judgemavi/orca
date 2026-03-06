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

export const REVIEW_STATUSES = {
  pending: 'pending',
  addressed: 'addressed',
} as const;

export type ReviewStatus =
  (typeof REVIEW_STATUSES)[keyof typeof REVIEW_STATUSES];

export const JOB_STATUSES = {
  queued: 'queued',
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
} as const;

export type JobStatus = (typeof JOB_STATUSES)[keyof typeof JOB_STATUSES];

export const JOB_TYPES = {
  code: 'code',
  evaluate: 'evaluate',
  plan: 'plan',
  breakdown: 'breakdown',
  review: 'review',
  explore: 'explore',
  merge: 'merge',
  retro: 'retro',
} as const;

export type JobType = (typeof JOB_TYPES)[keyof typeof JOB_TYPES];

export const JOB_PRIORITIES: Record<JobType, number> = {
  code: 0,
  review: 1,
  merge: 2,
  evaluate: 3,
  plan: 4,
  breakdown: 4,
  explore: 5,
  retro: 6,
};
