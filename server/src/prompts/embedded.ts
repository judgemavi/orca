import outputStyle from './md/output_style.md' with { type: 'text' }
import executorStyle from './md/executor_style.md' with { type: 'text' }
import plan from './md/plan.md' with { type: 'text' }
import review from './md/review.md' with { type: 'text' }
import retro from './md/retro.md' with { type: 'text' }
import explore from './md/explore.md' with { type: 'text' }
import evaluate from './md/evaluate.md' with { type: 'text' }
import breakdown from './md/breakdown.md' with { type: 'text' }
import syncContext from './md/sync_context.md' with { type: 'text' }
import conflictResolve from './md/conflict_resolve.md' with { type: 'text' }
import orchestrator from './md/orchestrator.md' with { type: 'text' }

export const embedded: Record<PromptName, string> = {
  outputStyle,
  executorStyle,
  plan,
  review,
  retro,
  explore,
  evaluate,
  breakdown,
  syncContext,
  conflictResolve,
  orchestrator,
}

export type PromptName = keyof typeof FILE_NAMES

export const FILE_NAMES = {
  outputStyle: 'output_style',
  executorStyle: 'executor_style',
  plan: 'plan',
  review: 'review',
  retro: 'retro',
  explore: 'explore',
  evaluate: 'evaluate',
  breakdown: 'breakdown',
  syncContext: 'sync_context',
  conflictResolve: 'conflict_resolve',
  orchestrator: 'orchestrator',
} as const
