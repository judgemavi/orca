export type BlockType = 'json' | 'markdown' | 'code' | 'diff' | 'text' | 'stderr'

export interface LogLine {
  raw: string
  stream: 'stdout' | 'stderr'
  ts?: string
}

export interface LogBlock {
  type: BlockType
  content: string
  language?: string
  stream: 'stdout' | 'stderr'
}

const MARKDOWN_PREFIX_RE = /^(#{1,6}\s|[-*+]\s|>\s|\d+\.\s|\*\*|`{1,3}|\|.+\||---$|___$)/

function isFenceLine(line: string): boolean {
  return line.trimStart().startsWith('```')
}

function parseFenceLanguage(line: string): string | undefined {
  const match = line.trim().match(/^```([a-zA-Z0-9_+-]+)?/)
  return match?.[1] || undefined
}

function startsJSON(line: string): boolean {
  const trimmed = line.trimStart()
  return trimmed.startsWith('{') || trimmed.startsWith('[')
}

function isLikelyProse(line: string): boolean {
  const trimmed = line.trim()
  if (trimmed.length < 24) return false
  if (!/[a-zA-Z]/.test(trimmed)) return false
  if (!trimmed.includes(' ')) return false
  if (/^[A-Z0-9_\-]+:\s/.test(trimmed)) return false
  return true
}

function isMarkdownLine(line: string): boolean {
  const trimmed = line.trimStart()
  return MARKDOWN_PREFIX_RE.test(trimmed) || isLikelyProse(line)
}

function isDiffStart(line: string): boolean {
  const trimmed = line.trimStart()
  return /^diff --git a\/.+ b\/.+$/.test(trimmed)
}

function isDiffContinuation(line: string): boolean {
  if (line === '') return true
  const trimmed = line.trimStart()
  return (
    trimmed.startsWith('diff --git ') ||
    trimmed.startsWith('index ') ||
    trimmed.startsWith('--- ') ||
    trimmed.startsWith('+++ ') ||
    trimmed.startsWith('@@ ') ||
    trimmed.startsWith('new file mode ') ||
    trimmed.startsWith('deleted file mode ') ||
    trimmed.startsWith('old mode ') ||
    trimmed.startsWith('new mode ') ||
    trimmed.startsWith('similarity index ') ||
    trimmed.startsWith('dissimilarity index ') ||
    trimmed.startsWith('rename from ') ||
    trimmed.startsWith('rename to ') ||
    trimmed.startsWith('Binary files ') ||
    line.startsWith('+') ||
    line.startsWith('-') ||
    line.startsWith(' ') ||
    line.startsWith('\\ No newline at end of file')
  )
}

function parsePossibleDiff(lines: LogLine[], start: number): { end: number; content: string } | null {
  if (!isDiffStart(lines[start]?.raw ?? '')) return null

  const stream = lines[start].stream
  const chunk: string[] = [lines[start].raw]
  let i = start + 1

  for (; i < lines.length; i++) {
    const line = lines[i]
    if (!line || line.stream !== stream) break
    if (!isDiffContinuation(line.raw)) break
    chunk.push(line.raw)
  }

  return { end: i - 1, content: chunk.join('\n') }
}

function parsePossibleJSON(lines: LogLine[], start: number): { end: number; content: string } | null {
  if (!startsJSON(lines[start]?.raw ?? '')) return null

  const candidate: string[] = []
  let depth = 0
  let inString = false
  let escaped = false

  for (let i = start; i < lines.length; i++) {
    const line = lines[i]
    if (!line || line.stream === 'stderr') return null
    if (isFenceLine(line.raw) && i !== start) return null

    candidate.push(line.raw)
    const text = line.raw
    for (let j = 0; j < text.length; j++) {
      const ch = text[j]
      if (inString) {
        if (escaped) {
          escaped = false
          continue
        }
        if (ch === '\\') {
          escaped = true
          continue
        }
        if (ch === '"') inString = false
        continue
      }
      if (ch === '"') {
        inString = true
        continue
      }
      if (ch === '{' || ch === '[') depth++
      if (ch === '}' || ch === ']') depth = Math.max(0, depth - 1)
    }

    const joined = candidate.join('\n')
    if (depth === 0) {
      try {
        const parsed = JSON.parse(joined)
        if (parsed !== null && typeof parsed === 'object') {
          return { end: i, content: joined }
        }
        return null
      } catch {
        return null
      }
    }

    if (candidate.length > 1000) return null
  }

  return null
}

export function parseLogBlocks(lines: LogLine[]): LogBlock[] {
  const blocks: LogBlock[] = []

  for (let i = 0; i < lines.length; ) {
    const line = lines[i]

    const diff = parsePossibleDiff(lines, i)
    if (diff) {
      blocks.push({ type: 'diff', stream: line.stream, content: diff.content })
      i = diff.end + 1
      continue
    }

    if (line.stream === 'stderr') {
      const chunk: string[] = [line.raw]
      i++
      while (i < lines.length && lines[i].stream === 'stderr') {
        chunk.push(lines[i].raw)
        i++
      }
      blocks.push({ type: 'stderr', stream: 'stderr', content: chunk.join('\n') })
      continue
    }

    if (isFenceLine(line.raw)) {
      const language = parseFenceLanguage(line.raw)
      const chunk: string[] = []
      i++
      while (i < lines.length) {
        if (lines[i].stream === 'stderr') break
        if (isFenceLine(lines[i].raw)) {
          i++
          break
        }
        chunk.push(lines[i].raw)
        i++
      }
      blocks.push({
        type: 'code',
        stream: 'stdout',
        language,
        content: chunk.join('\n'),
      })
      continue
    }

    const json = parsePossibleJSON(lines, i)
    if (json) {
      blocks.push({ type: 'json', stream: 'stdout', content: json.content })
      i = json.end + 1
      continue
    }

    if (isMarkdownLine(line.raw)) {
      const chunk: string[] = [line.raw]
      i++
      while (i < lines.length && lines[i].stream === 'stdout') {
        const current = lines[i].raw
        if (isFenceLine(current) || startsJSON(current)) break
        if (current.trim() === '') {
          const next = lines[i + 1]
          if (next && next.stream === 'stdout' && isMarkdownLine(next.raw)) {
            chunk.push(current)
            i++
            continue
          }
          break
        }
        if (!isMarkdownLine(current)) break
        chunk.push(current)
        i++
      }
      blocks.push({ type: 'markdown', stream: 'stdout', content: chunk.join('\n') })
      continue
    }

    const chunk: string[] = [line.raw]
    i++
    while (i < lines.length && lines[i].stream === 'stdout') {
      const current = lines[i].raw
      if (isFenceLine(current) || startsJSON(current) || isMarkdownLine(current)) break
      chunk.push(current)
      i++
    }
    blocks.push({ type: 'text', stream: 'stdout', content: chunk.join('\n') })
  }

  return blocks
}
