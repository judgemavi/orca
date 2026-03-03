import {
  extractPlanText,
  normalizeToolName,
  parseBreakdownPayload,
  parseEvaluationPayload,
  parseJSONText,
} from './orchestratorRichContent'

export interface PhaseAction {
  key: string
  label: string
  response: string
  variant: 'primary' | 'default' | 'destructive'
  needsInput?: boolean
  inputPlaceholder?: string
}

export interface PhaseActionSet {
  actions: PhaseAction[]
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function hasMergedTasks(payload: unknown): boolean {
  const source = asRecord(payload)
  if (!source) return false
  if (asString(source.status).trim().toLowerCase() === 'merged') return true
  const merged = source.merged
  return Array.isArray(merged) && merged.length > 0
}

function hasReviewResult(payload: unknown): boolean {
  const source = asRecord(payload)
  if (!source) return false
  const results = source.results
  if (!Array.isArray(results)) return false
  return results.some((entry) => {
    const record = asRecord(entry)
    if (!record) return false
    const status = asString(record.status).trim().toLowerCase()
    return status === 'review' || status === 'failed'
  })
}

function hasBreakdownProposals(payload: unknown): boolean {
  const parsed = parseBreakdownPayload(payload)
  if (parsed && parsed.proposed.length > 0) return true

  const source = asRecord(payload)
  if (!source) return false
  const proposed = source.proposed_tasks
  if (!Array.isArray(proposed)) return false
  const created = source.created
  return created !== true && proposed.length > 0
}

export function parseToolResultPayload(toolName: string, rawResult: string): unknown {
  const parsed = parseJSONText(rawResult)
  if (toolName === 'tasks_plan_generate' && parsed === null) {
    return rawResult
  }
  return parsed
}

export function detectPhaseActions(
  toolNameRaw: string,
  resultPayload: unknown,
): PhaseActionSet | null {
  const toolName = normalizeToolName(toolNameRaw)

  switch (toolName) {
    case 'tasks_plan_generate': {
      if (!extractPlanText(resultPayload)) return null
      return {
        actions: [
          {
            key: 'approve_plan',
            label: 'Approve Plan',
            response: 'Approve the plan for this task.',
            variant: 'primary',
          },
          {
            key: 'request_plan_changes',
            label: 'Request Plan Changes',
            response: 'Request plan changes',
            variant: 'default',
            needsInput: true,
            inputPlaceholder: 'What should change in this plan?',
          },
        ],
      }
    }
    case 'tasks_plan_evaluate': {
      const root = asRecord(resultPayload)
      const evaluationPayload = root?.evaluation ?? resultPayload
      const evaluation = parseEvaluationPayload(evaluationPayload)
      if (!evaluation) return null
      const actions: PhaseAction[] = [
        {
          key: 'generate_plan',
          label: 'Generate Plan',
          response: 'Generate a detailed implementation plan for this task.',
          variant: 'primary',
        },
      ]
      if (evaluation.needsBreakdown) {
        actions.push({
          key: 'breakdown_task',
          label: 'Breakdown',
          response: 'Break down this task into subtasks before planning.',
          variant: 'default',
        })
      }
      return { actions }
    }
    case 'breakdown': {
      if (!hasBreakdownProposals(resultPayload)) return null
      return {
        actions: [
          {
            key: 'accept_breakdown',
            label: 'Accept Breakdown',
            response: 'Accept this breakdown and proceed with the proposed subtasks.',
            variant: 'primary',
          },
          {
            key: 'reject_breakdown',
            label: 'Reject Breakdown',
            response: 'Reject this breakdown and suggest a different split.',
            variant: 'default',
          },
        ],
      }
    }
    case 'tasks_start': {
      if (!hasReviewResult(resultPayload)) return null
      return {
        actions: [
          {
            key: 'approve_task',
            label: 'Approve',
            response: 'Approve this task.',
            variant: 'primary',
          },
          {
            key: 'request_changes',
            label: 'Request Changes',
            response: 'Request changes',
            variant: 'default',
            needsInput: true,
            inputPlaceholder: 'What changes are needed?',
          },
          {
            key: 'run_ai_review',
            label: 'AI Review',
            response: 'Run AI review for this task.',
            variant: 'default',
          },
        ],
      }
    }
    case 'ai_review': {
      const source = asRecord(resultPayload)
      if (!source || typeof source.approved !== 'boolean') return null
      if (source.approved) {
        return {
          actions: [
            {
              key: 'approve_task',
              label: 'Approve',
              response: 'Approve this task.',
              variant: 'primary',
            },
            {
              key: 'request_changes',
              label: 'Request Changes',
              response: 'Request changes',
              variant: 'default',
              needsInput: true,
              inputPlaceholder: 'What should be changed?',
            },
          ],
        }
      }
      return {
        actions: [
          {
            key: 'request_changes',
            label: 'Request Changes',
            response: 'Request changes',
            variant: 'primary',
            needsInput: true,
            inputPlaceholder: 'What should be changed?',
          },
          {
            key: 'approve_anyway',
            label: 'Approve Anyway',
            response: 'Approve this task despite the review findings.',
            variant: 'default',
          },
        ],
      }
    }
    case 'tasks_approve': {
      const source = asRecord(resultPayload)
      if (!source || asString(source.status).trim().toLowerCase() !== 'approved') {
        return null
      }
      return {
        actions: [
          {
            key: 'merge_task',
            label: 'Merge',
            response: 'Merge this task.',
            variant: 'primary',
          },
          {
            key: 'run_retro',
            label: 'Run Retro',
            response: 'Run retrospective for this task.',
            variant: 'default',
          },
        ],
      }
    }
    case 'tasks_merge': {
      if (!hasMergedTasks(resultPayload)) return null
      return {
        actions: [
          {
            key: 'run_retro',
            label: 'Run Retro',
            response: 'Run retrospective for this task.',
            variant: 'primary',
          },
        ],
      }
    }
    default:
      return null
  }
}
