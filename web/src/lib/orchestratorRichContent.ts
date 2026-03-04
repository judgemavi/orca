import type { ProposedTask } from '../types'

interface PlanSection {
  key: string
  title: string
  content: string
}

interface ParsedEvaluation {
  complexity?: string
  needsBreakdown: boolean
  confidence?: number
  reasoning: string
}

interface ParsedBreakdown {
  proposed: ProposedTask[]
  accepted?: boolean
  rejected?: boolean
}

export function parseJSONText(text: string): unknown | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    return null
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

function asNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  const out: number[] = []
  for (const item of value) {
    const parsed = asNumber(item)
    if (Number.isFinite(parsed)) out.push(Math.trunc(parsed as number))
  }
  return out
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

export function parseEvaluationPayload(payload: unknown): ParsedEvaluation | null {
  const sourceRoot = asRecord(payload)
  const source = asRecord(sourceRoot?.evaluation) ?? sourceRoot
  if (!source) return null

  const needsBreakdownSource =
    typeof source.needsBreakdown === 'boolean'
      ? source.needsBreakdown
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
    : Array.isArray(source.proposedTasks)
      ? source.proposedTasks
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
      dependsOnIndices: asNumberArray(
        task.dependsOnIndices ?? task.dependsOn,
      ),
      suggestedTool: asString(task.suggestedTool ?? task.tool).trim(),
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
