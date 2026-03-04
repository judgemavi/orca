export type DiffChangeType = 'minor' | 'medium' | 'major' | 'deleted' | 'renamed'

export interface DiffClassifiedFile {
  type: DiffChangeType
  oldPath: string
  newPath: string
  churn: number
}

export interface DiffClassificationResult {
  files: DiffClassifiedFile[]
  byPath: Record<string, DiffChangeType>
  overall: DiffChangeType | ''
  totalChurn: number
}

export function classifyDiffFromGit(
  nameStatusRaw: string,
  numStatRaw: string,
): DiffClassificationResult {
  const lineStats = parseNumStat(numStatRaw)
  const files: DiffClassifiedFile[] = []
  const byPath: Record<string, DiffChangeType> = {}
  let totalChurn = 0
  let topRank = 0
  let overall: DiffChangeType | '' = ''

  for (const line of nameStatusRaw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue

    const parts = trimmed.split('\t')
    if (parts.length < 2) continue
    const code = (parts[0] ?? '').trim()

    if (code.startsWith('R') && parts.length >= 3) {
      const oldPath = (parts[1] ?? '').trim()
      const newPath = (parts[2] ?? '').trim()
      const churn = lookupChurn(lineStats, oldPath, newPath)
      files.push({ type: 'renamed', oldPath: oldPath, newPath: newPath, churn })
      if (oldPath) byPath[oldPath] = 'renamed'
      if (newPath) byPath[newPath] = 'renamed'
      totalChurn += churn
      if (rankFor('renamed') > topRank) {
        topRank = rankFor('renamed')
        overall = 'renamed'
      }
      continue
    }

    const path = (parts[1] ?? '').trim()
    if (!path) continue

    if (code.startsWith('D')) {
      files.push({ type: 'deleted', oldPath: path, newPath: '', churn: 0 })
      byPath[path] = 'deleted'
      if (rankFor('deleted') > topRank) {
        topRank = rankFor('deleted')
        overall = 'deleted'
      }
      continue
    }

    const churn = lookupChurn(lineStats, path)
    const type = classifyChurn(churn)
    files.push({ type, oldPath: path, newPath: path, churn })
    byPath[path] = type
    totalChurn += churn
    if (rankFor(type) > topRank) {
      topRank = rankFor(type)
      overall = type
    }
  }

  return {
    files,
    byPath: byPath,
    overall,
    totalChurn: totalChurn,
  }
}

export function rankFor(change: DiffChangeType): number {
  switch (change) {
    case 'deleted':
      return 5
    case 'major':
      return 4
    case 'renamed':
      return 3
    case 'medium':
      return 2
    case 'minor':
      return 1
    default:
      return 0
  }
}

function classifyChurn(churn: number): DiffChangeType {
  if (churn > 100) return 'major'
  if (churn >= 20) return 'medium'
  return 'minor'
}

function lookupChurn(
  lineStats: Map<string, number>,
  ...paths: string[]
): number {
  for (const path of paths) {
    if (!path) continue
    if (lineStats.has(path)) {
      return lineStats.get(path) ?? 0
    }
  }
  return 0
}

function parseNumStat(raw: string): Map<string, number> {
  const out = new Map<string, number>()
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const parts = trimmed.split('\t')
    if (parts.length < 3) continue

    const added = parseCount(parts[0] ?? '')
    const removed = parseCount(parts[1] ?? '')
    const churn = added + removed

    const rawPath = (parts[2] ?? '').trim()
    if (!rawPath) continue

    for (const path of expandRenamePath(rawPath)) {
      out.set(path, churn)
    }
  }
  return out
}

function parseCount(raw: string): number {
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 0) return 0
  return parsed
}

function expandRenamePath(rawPath: string): string[] {
  const out = new Set<string>()
  out.add(rawPath)

  if (!rawPath.includes('=>')) {
    return [...out]
  }

  const brace = rawPath.match(/^(.*)\{(.+?) => (.+?)\}(.*)$/)
  if (brace) {
    const oldPath = `${brace[1] ?? ''}${brace[2] ?? ''}${brace[4] ?? ''}`.trim()
    const newPath = `${brace[1] ?? ''}${brace[3] ?? ''}${brace[4] ?? ''}`.trim()
    if (oldPath) out.add(oldPath)
    if (newPath) out.add(newPath)
    return [...out]
  }

  const parts = rawPath.split(/\s+=>\s+/)
  if (parts.length >= 2) {
    const oldPath = (parts[0] ?? '').trim()
    const newPath = (parts[1] ?? '').trim()
    if (oldPath) out.add(oldPath)
    if (newPath) out.add(newPath)
  }

  return [...out]
}
