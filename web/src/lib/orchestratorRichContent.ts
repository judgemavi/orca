import type { ProposedTask } from '../types'

export interface PlanSection {
  key: string
  title: string
  content: string
}

export interface ReviewCheck {
  key: string
  label: string
  passed: boolean
}

export interface ReviewFinding {
  id: string
  summary: string
  detail: string
  passed: boolean
  filePath?: string
  line?: number
}

export interface ParsedReview {
  taskId?: string
  approved: boolean
  feedback: string
  tool?: string
  checks: ReviewCheck[]
  findings: ReviewFinding[]
}

export interface ToolTaskSummary {
  id: string
  title: string
  status: string
}

export interface MemoryResultEntry {
  id: string
  content: string
  category: string
  confidence?: number
  tags: string[]
  sourceType?: string
  stale?: boolean
  filePaths: string[]
}

export interface ParsedEvaluation {
  complexity?: string
  needsBreakdown: boolean
  confidence?: number
  reasoning: string
}

export interface ParsedBreakdown {
  proposed: ProposedTask[]
  accepted?: boolean
  rejected?: boolean
}

const TASK_ID_IN_BACKTICKS_RE = /`([a-f0-9]{8,64})`/gi
const FILE_REF_RE = /([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)(?::(\d+))?/

export function parseJSONText(text: string): unknown | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    return null
  }
}

export function toPrettyJSON(value: unknown): string {
  if (typeof value === 'string') {
    const parsed = parseJSONText(value)
    if (parsed === null) return value
    return JSON.stringify(parsed, null, 2)
  }
  if (value === undefined) return '{}'
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export function normalizeToolName(name: string): string {
  const trimmed = name.trim().toLowerCase()
  if (!trimmed) return 'tool'

  const mcpMatch = trimmed.match(/^mcp__[^_]+__(.+)$/)
  if (mcpMatch?.[1]) return mcpMatch[1]

  return trimmed
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item === 'string' && item.trim() !== '') {
      out.push(item.trim())
    }
  }
  return out
}

function asNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  const out: number[] = []
  for (const item of value) {
    const parsed = asNumber(item)
    if (Number.isFinite(parsed)) out.push(Math.trunc(parsed as number))
  }
  return out
}

export function extractBacktickedTaskIDs(content: string): string[] {
  if (!content) return []
  const seen = new Set<string>()
  const ids: string[] = []

  for (const match of content.matchAll(TASK_ID_IN_BACKTICKS_RE)) {
    const id = (match[1] ?? '').toLowerCase()
    if (!id || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }

  return ids
}

function canonicalSectionTitle(rawTitle: string): string {
  const normalized = rawTitle.trim().toLowerCase().replace(/[^a-z0-9 ]+/g, '')

  if (normalized === 'approach' || normalized === 'strategy') return 'Approach'
  if (normalized === 'files' || normalized === 'file changes') return 'Files'
  if (normalized === 'steps' || normalized === 'implementation steps') {
    return 'Steps'
  }
  if (normalized === 'edge cases' || normalized === 'edge case') {
    return 'Edge Cases'
  }
  if (normalized === 'tests' || normalized === 'testing') return 'Tests'

  return rawTitle.trim()
}

function sectionSortWeight(title: string): number {
  switch (title.toLowerCase()) {
    case 'approach':
      return 0
    case 'files':
      return 1
    case 'steps':
      return 2
    case 'edge cases':
      return 3
    case 'tests':
      return 4
    default:
      return 100
  }
}

export function extractPlanText(payload: unknown): string {
  if (typeof payload === 'string') return payload.trim()
  const record = asRecord(payload)
  if (!record) return ''
  const plan = record.plan
  return typeof plan === 'string' ? plan.trim() : ''
}

export function parsePlanSections(text: string): PlanSection[] {
  const trimmed = text.trim()
  if (!trimmed) return []

  const source = trimmed.replace(/\r\n/g, '\n')
  const headingRe = /^##\s+(.+)$/gm
  const headings: Array<{
    title: string
    headingStart: number
    contentStart: number
  }> = []

  for (const match of source.matchAll(headingRe)) {
    const matchText = match[0]
    const title = (match[1] ?? '').trim()
    const index = match.index ?? -1
    if (index < 0 || !matchText) continue
    headings.push({
      title,
      headingStart: index,
      contentStart: index + matchText.length,
    })
  }

  if (headings.length === 0) {
    return [{ key: 'plan', title: 'Plan', content: source }]
  }

  const parsed: PlanSection[] = headings
    .map((heading, index) => {
      const nextHeadingStart =
        index + 1 < headings.length
          ? headings[index + 1].headingStart
          : source.length
      const content = source.slice(heading.contentStart, nextHeadingStart).trim()
      const title = canonicalSectionTitle(heading.title)
      return {
        key: `${title.toLowerCase().replace(/\s+/g, '_')}-${index}`,
        title,
        content: content || '_No details provided._',
      }
    })
    .sort((a, b) => sectionSortWeight(a.title) - sectionSortWeight(b.title))

  return parsed
}

export function parseToolTasks(payload: unknown): ToolTaskSummary[] {
  const source = asRecord(payload)
  const rawTasks = source?.tasks
  if (!Array.isArray(rawTasks)) return []

  const tasks: ToolTaskSummary[] = []
  for (const rawTask of rawTasks) {
    const task = asRecord(rawTask)
    if (!task) continue
    const id = asString(task.id).trim()
    if (!id) continue
    tasks.push({
      id,
      title: asString(task.title).trim() || id,
      status: asString(task.status).trim() || 'unknown',
    })
  }
  return tasks
}

export function parseCreatedTask(payload: unknown): ToolTaskSummary | null {
  const source = asRecord(payload)
  const rawTask = source?.task
  const task = asRecord(rawTask)
  if (!task) return null
  const id = asString(task.id).trim()
  if (!id) return null
  return {
    id,
    title: asString(task.title).trim() || id,
    status: asString(task.status).trim() || 'unknown',
  }
}

export function parseMemoryEntries(payload: unknown): MemoryResultEntry[] {
  const source = asRecord(payload)
  const rawEntries = source?.entries
  if (!Array.isArray(rawEntries)) return []

  const entries: MemoryResultEntry[] = []
  for (const rawEntry of rawEntries) {
    const entry = asRecord(rawEntry)
    if (!entry) continue

    const content = asString(entry.content).trim()
    if (!content) continue
    const id = asString(entry.id).trim()
    entries.push({
      id: id || 'unknown',
      content,
      category: asString(entry.category).trim() || 'uncategorized',
      confidence: asNumber(entry.confidence),
      tags: asStringArray(entry.tags),
      sourceType: asString(entry.source_type).trim() || undefined,
      stale: typeof entry.stale === 'boolean' ? entry.stale : undefined,
      filePaths: asStringArray(entry.file_paths),
    })
  }

  return entries
}

export function parseProjectStatusPayload(payload: unknown): {
  project?: string
  totalTasks?: number
  byStatus: Record<string, number>
} | null {
  const source = asRecord(payload)
  if (!source) return null

  const byStatus: Record<string, number> = {}
  const rawByStatus = asRecord(source.by_status)
  if (rawByStatus) {
    for (const [key, value] of Object.entries(rawByStatus)) {
      const count = asNumber(value)
      if (count !== undefined) byStatus[key] = count
    }
  } else {
    const knownStatuses = [
      'pending',
      'planned',
      'running',
      'stopped',
      'review',
      'approved',
      'broken_down',
      'merged',
      'failed',
    ]
    for (const key of knownStatuses) {
      const count = asNumber(source[key])
      if (count !== undefined) byStatus[key] = count
    }
  }

  return {
    project: asString(source.project).trim() || undefined,
    totalTasks: asNumber(source.total_tasks),
    byStatus,
  }
}

export function parseEvaluationPayload(payload: unknown): ParsedEvaluation | null {
  const sourceRoot = asRecord(payload)
  const source = asRecord(sourceRoot?.evaluation) ?? sourceRoot
  if (!source) return null

  const needsBreakdownSource =
    typeof source.needs_breakdown === 'boolean'
      ? source.needs_breakdown
      : typeof source.needsBreakdown === 'boolean'
        ? source.needsBreakdown
        : null
  const reasoningSource = asString(source.reasoning).trim()
  if (needsBreakdownSource === null || !reasoningSource) return null

  return {
    complexity: asString(source.complexity).trim() || undefined,
    needsBreakdown: needsBreakdownSource,
    confidence: asNumber(source.confidence),
    reasoning: reasoningSource,
  }
}

export function parseBreakdownPayload(payload: unknown): ParsedBreakdown | null {
  const source = asRecord(payload)
  if (!source) return null

  const rawProposed = Array.isArray(source.proposed)
    ? source.proposed
    : Array.isArray(source.proposed_tasks)
      ? source.proposed_tasks
      : []
  const proposed: ProposedTask[] = []
  for (const rawTask of rawProposed) {
    const task = asRecord(rawTask)
    if (!task) continue
    const title = asString(task.title).trim()
    const description = asString(task.description).trim()
    if (!title && !description) continue
    proposed.push({
      title: title || 'Untitled task',
      description,
      depends_on_indices: asNumberArray(
        task.depends_on_indices ?? task.depends_on,
      ),
      suggested_tool: asString(task.suggested_tool ?? task.tool).trim(),
    })
  }

  const accepted = typeof source.accepted === 'boolean' ? source.accepted : undefined
  const rejected = typeof source.rejected === 'boolean' ? source.rejected : undefined
  if (proposed.length === 0 && accepted === undefined && rejected === undefined) {
    return null
  }

  return {
    proposed,
    accepted,
    rejected,
  }
}

function inferFindingStatus(text: string, fallbackApproved: boolean): boolean {
  const lower = text.toLowerCase()
  const failHints = [
    'issue',
    'bug',
    'error',
    'missing',
    'should',
    'must',
    'unsafe',
    'regression',
    'fail',
    'incorrect',
  ]
  const passHints = ['looks good', 'no issue', 'approved', 'pass', 'ok']
  if (failHints.some((hint) => lower.includes(hint))) return false
  if (passHints.some((hint) => lower.includes(hint))) return true
  return fallbackApproved
}

function buildReviewChecks(approved: boolean, feedback: string): ReviewCheck[] {
  const lower = feedback.toLowerCase()
  const labels: Array<{ key: string; label: string; hints: string[] }> = [
    {
      key: 'correctness',
      label: 'Correctness',
      hints: ['correctness', 'bug', 'error', 'race', 'nil', 'null'],
    },
    {
      key: 'style',
      label: 'Style',
      hints: ['style', 'naming', 'format', 'idiomatic'],
    },
    {
      key: 'tests',
      label: 'Tests',
      hints: ['test', 'coverage', 'edge case'],
    },
    {
      key: 'cleanup',
      label: 'Cleanup',
      hints: ['todo', 'fixme', 'debug', 'commented-out'],
    },
  ]

  return labels.map((item) => {
    const mentioned = item.hints.some((hint) => lower.includes(hint))
    const passed = approved && (!mentioned || inferFindingStatus(feedback, true))
    return {
      key: item.key,
      label: item.label,
      passed,
    }
  })
}

function parseFindings(feedback: string, approved: boolean): ReviewFinding[] {
  const lines = feedback
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^([-*+]|\d+\.)\s+/, '').trim())
    .filter(Boolean)

  if (lines.length === 0 && feedback.trim() !== '') {
    lines.push(feedback.trim())
  }

  return lines.map((line, index) => {
    const ref = line.match(FILE_REF_RE)
    const filePath = ref?.[1]
    const lineNumber = ref?.[2] ? Number(ref[2]) : undefined
    const summary = line.length > 100 ? `${line.slice(0, 100)}...` : line
    return {
      id: `finding-${index}`,
      summary,
      detail: line,
      passed: inferFindingStatus(line, approved),
      filePath,
      line: Number.isFinite(lineNumber) ? lineNumber : undefined,
    }
  })
}

export function parseReviewPayload(payload: unknown): ParsedReview {
  const source = asRecord(payload)
  if (!source) {
    return {
      approved: false,
      feedback: '',
      checks: buildReviewChecks(false, ''),
      findings: [],
    }
  }

  const approved = Boolean(source.approved)
  const feedback = asString(source.feedback).trim()
  return {
    taskId: asString(source.task_id).trim() || undefined,
    approved,
    feedback,
    tool: asString(source.tool).trim() || undefined,
    checks: buildReviewChecks(approved, feedback),
    findings: parseFindings(feedback, approved),
  }
}
