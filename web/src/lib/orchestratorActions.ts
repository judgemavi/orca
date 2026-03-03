export type ActionType =
  | 'approve_reject'
  | 'approve_changes'
  | 'confirm'
  | 'merge'

export interface DetectedAction {
  type: ActionType
  labels: [string, string]
  responses: [string, string]
}

const APPROVE_CHANGES_ACTION: DetectedAction = {
  type: 'approve_changes',
  labels: ['Approve', 'Request Changes'],
  responses: ['Approve', 'Request Changes'],
}

const APPROVE_REJECT_ACTION: DetectedAction = {
  type: 'approve_reject',
  labels: ['Approve', 'Reject'],
  responses: ['Approve', 'Reject'],
}

const CONFIRM_ACTION: DetectedAction = {
  type: 'confirm',
  labels: ['Start', 'Skip'],
  responses: ['Start', 'Skip'],
}

const MERGE_ACTION: DetectedAction = {
  type: 'merge',
  labels: ['Merge', 'Skip'],
  responses: ['Merge', 'Skip'],
}

function normalizeContent(content: string): string {
  return content.replace(/\s+/g, ' ').trim()
}

export function detectAction(content: string): DetectedAction | null {
  const normalized = normalizeContent(content)
  if (!normalized) return null

  if (
    /\brequest(?:\s+\w+){0,3}\s+changes?\s*\?/i.test(normalized) ||
    /\bapprove(?:\s+or)?\s+request(?:\s+\w+){0,2}\s+changes?\s*\?/i.test(
      normalized,
    )
  ) {
    return APPROVE_CHANGES_ACTION
  }

  if (/\bapprove(?:\s+(?:to\s+merge|plan))?\s*\?/i.test(normalized)) {
    return APPROVE_REJECT_ACTION
  }

  if (
    /\brun\s+`?tasks_start`?\s*\?/i.test(normalized) ||
    /\bexecute\s*\?/i.test(normalized) ||
    /\bstart\s*\?/i.test(normalized)
  ) {
    return CONFIRM_ACTION
  }

  if (/\bmerge\s*\?/i.test(normalized)) {
    return MERGE_ACTION
  }

  return null
}

