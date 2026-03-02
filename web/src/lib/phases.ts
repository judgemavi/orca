export const PHASES = {
  explore: 'explore',
  plan: 'plan',
  evaluate: 'evaluate',
  breakdown: 'breakdown',
  run: 'run',
  revise: 'revise',
  review: 'review',
  merge: 'merge',
  retro: 'retro',
} as const

export type InteractionPhase = (typeof PHASES)[keyof typeof PHASES]

export const INTERACTION_STATUSES = {
  running: 'running',
  completed: 'completed',
  failed: 'failed',
} as const

export type InteractionStatus =
  (typeof INTERACTION_STATUSES)[keyof typeof INTERACTION_STATUSES]

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
} as const

export type TaskStatus = (typeof TASK_STATUSES)[keyof typeof TASK_STATUSES]

export const REVIEW_STATUSES = {
  pending: 'pending',
  addressed: 'addressed',
} as const

export type ReviewStatus =
  (typeof REVIEW_STATUSES)[keyof typeof REVIEW_STATUSES]

export const PHASE_LABELS: Record<string, string> = {
  [PHASES.plan]: 'Planning',
  [PHASES.evaluate]: 'Evaluation',
  [PHASES.breakdown]: 'Breakdown',
  [PHASES.run]: 'Run',
  [PHASES.revise]: 'Run',
  [PHASES.review]: 'Review',
  [PHASES.merge]: 'Merge',
  [PHASES.retro]: 'Retro',
  [PHASES.explore]: 'Explore',
}

export const isRunLike = (phase: string) =>
  phase === PHASES.run || phase === PHASES.revise
