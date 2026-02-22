import { parseLogBlocks, type LogLine } from './logParser'

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message)
  }
}

function lines(raw: Array<[string, 'stdout' | 'stderr']>): LogLine[] {
  return raw.map(([content, stream]) => ({ raw: content, stream }))
}

export function runLogParserTests(): void {
  const jsonBlocks = parseLogBlocks(
    lines([
      ['{"ok": true}', 'stdout'],
      ['normal line', 'stdout'],
    ]),
  )
  assert(jsonBlocks[0]?.type === 'json', 'expected first block to be json')
  assert(jsonBlocks[1]?.type === 'text', 'expected second block to be text')

  const markdownBlocks = parseLogBlocks(
    lines([
      ['# Header', 'stdout'],
      [
        'This is prose that should be markdown rendered in one block.',
        'stdout',
      ],
    ]),
  )
  assert(markdownBlocks.length === 1, 'expected one markdown block')
  assert(markdownBlocks[0]?.type === 'markdown', 'expected markdown block')

  const codeBlocks = parseLogBlocks(
    lines([
      ['```ts', 'stdout'],
      ['const x = 1', 'stdout'],
      ['```', 'stdout'],
    ]),
  )
  assert(codeBlocks[0]?.type === 'code', 'expected code block')
  assert(codeBlocks[0]?.language === 'ts', 'expected language hint')

  const stderrBlocks = parseLogBlocks(
    lines([
      ['failed to execute', 'stderr'],
      ['stack trace', 'stderr'],
    ]),
  )
  assert(stderrBlocks[0]?.type === 'stderr', 'expected stderr block type')
}
