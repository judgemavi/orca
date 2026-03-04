import type { Driver, DriverEvent, HeadlessOpts } from '../driver/types'
import { toErrorMessage } from '../shared/errors'
import { gitOutput } from '../shared/git'

export interface WorkerOutputLine {
  stream: 'stdout' | 'stderr'
  line: string
  ts: string
}

export interface WorkerRunOptions {
  taskID: string
  driverName: string
  driver: Driver
  prompt: string
  model: string
  dir: string
  resumeSessionID?: string
  feedback?: string
  headlessOpts?: HeadlessOpts
  timeoutMS?: number
  cwd: string
  logsDir: string
  logPath?: string
  signal?: AbortSignal
  onLine?: (line: WorkerOutputLine) => void | Promise<void>
  onEvent?: (event: DriverEvent) => void | Promise<void>
}

export interface WorkerRunResult {
  exitCode: number
  signalCode: string | number | null
  sessionID: string
  events: DriverEvent[]
  inputTokens: number
  outputTokens: number
  estimatedCost: number
  diff: string
  filesChanged: string[]
  logPath: string
  durationMS: number
  timedOut: boolean
  aborted: boolean
  error?: string
}

export async function runTool(options: WorkerRunOptions): Promise<WorkerRunResult> {
  const logPath = options.logPath?.trim() || `${options.logsDir}/${options.taskID}.${Date.now()}.log`
  const resumeSession = (options.resumeSessionID ?? '').trim()
  const args = resumeSession
    ? options.driver.resumeArgs(
        resumeSession,
        options.feedback ?? '',
        options.model,
        options.dir,
        options.headlessOpts,
      )
    : options.driver.headlessArgs(
        options.prompt,
        options.model,
        options.dir,
        options.headlessOpts,
      )
  const timeoutMS = options.timeoutMS ?? 10 * 60_000

  await Bun.$`mkdir -p ${dirName(logPath)}`

  const child = Bun.spawn({
    cmd: [options.driver.binary(), ...args],
    cwd: options.cwd,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: filteredEnv(process.env),
  })

  const writer = Bun.file(logPath).writer()
  let writeQueue = Promise.resolve()
  let writeError = ''
  const queueWrite = (text: string) => {
    if (!text) return
    writeQueue = writeQueue.then(async () => {
      try {
        await writer.write(text)
      } catch (error) {
        writeError = toErrorMessage(error)
      }
    })
  }

  let sessionID = ''
  let inputTokens = 0
  let outputTokens = 0
  let estimatedCost = 0
  const events: DriverEvent[] = []
  const emitLine = (stream: 'stdout' | 'stderr', line: string) => {
    const value = line.replace(/\r$/, '')
    if (stream === 'stdout') {
      const event = options.driver.parseEvent(Buffer.from(value))
      if (event) {
        events.push(event)
        if (event.type === 'session' && event.sessionID?.trim()) {
          sessionID = event.sessionID.trim()
        }
        if (event.type === 'cost' && event.cost) {
          inputTokens += Math.max(0, Math.trunc(event.cost.inputTokens))
          outputTokens += Math.max(0, Math.trunc(event.cost.outputTokens))
          estimatedCost += Math.max(0, event.cost.totalCost)
          if (event.sessionID?.trim()) {
            sessionID = event.sessionID.trim()
          }
        }
        if (options.onEvent) {
          void Promise.resolve(options.onEvent(event)).catch(() => {})
        }
      }
    } else if (value.trim()) {
      const event: DriverEvent = { type: 'error', text: value, raw: value }
      events.push(event)
      if (options.onEvent) {
        void Promise.resolve(options.onEvent(event)).catch(() => {})
      }
    }
    if (options.onLine) {
      void Promise.resolve(
        options.onLine({
          stream,
          line: value,
          ts: new Date().toISOString(),
        }),
      ).catch(() => {})
    }
  }

  let timedOut = false
  let aborted = false

  const abort = () => {
    aborted = true
    try {
      child.kill()
    } catch {
      // Already exited.
    }
  }

  const timeoutHandle = setTimeout(() => {
    timedOut = true
    try {
      child.kill()
    } catch {
      // Already exited.
    }
  }, timeoutMS)

  let removeAbortListener: (() => void) | undefined
  if (options.signal) {
    if (options.signal.aborted) {
      abort()
    } else {
      const onAbort = () => abort()
      options.signal.addEventListener('abort', onAbort)
      removeAbortListener = () => options.signal?.removeEventListener('abort', onAbort)
    }
  }

  const start = Date.now()

  await Promise.all([
    consumeStream(child.stdout, 'stdout', queueWrite, emitLine),
    consumeStream(child.stderr, 'stderr', queueWrite, emitLine),
  ])

  const exitCode = await child.exited

  clearTimeout(timeoutHandle)
  removeAbortListener?.()

  await writeQueue
  try {
    await writer.flush()
  } catch {
    // Ignore flush errors and attempt close anyway.
  }
  try {
    await writer.end()
  } catch {
    // Ignore close errors.
  }

  const error = buildWorkerError({
    aborted,
    timedOut,
    timeoutMS,
    writeError,
    exitCode,
  })
  if (!sessionID) {
    sessionID = options.driver.parseSessionID(events) ?? ''
  }

  const commitMessage = buildCommitMessage(options.taskID, options.prompt)
  const { diff, filesChanged } = await finalizeGitWorktree(options.cwd, commitMessage)

  return {
    exitCode,
    signalCode: child.signalCode,
    sessionID,
    events,
    inputTokens,
    outputTokens,
    estimatedCost,
    diff,
    filesChanged,
    logPath,
    durationMS: Date.now() - start,
    timedOut,
    aborted,
    error,
  }
}


async function consumeStream(
  stream: ReadableStream<Uint8Array> | null,
  streamName: 'stdout' | 'stderr',
  onChunk: (text: string) => void,
  onLine: (stream: 'stdout' | 'stderr', line: string) => void,
): Promise<void> {
  if (!stream) return

  const decoder = new TextDecoder()
  const reader = stream.getReader()
  let pending = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value || value.length === 0) continue

    const text = decoder.decode(value, { stream: true })
    if (text) {
      onChunk(text)
      pending += text
    }

    let lineBreak = pending.indexOf('\n')
    while (lineBreak >= 0) {
      const line = pending.slice(0, lineBreak)
      onLine(streamName, line)
      pending = pending.slice(lineBreak + 1)
      lineBreak = pending.indexOf('\n')
    }
  }

  const finalChunk = decoder.decode()
  if (finalChunk) {
    onChunk(finalChunk)
    pending += finalChunk
  }

  if (pending.length > 0) {
    onLine(streamName, pending)
  }
}

function buildWorkerError(input: {
  aborted: boolean
  timedOut: boolean
  timeoutMS: number
  writeError: string
  exitCode: number
}): string | undefined {
  if (input.timedOut) {
    return `process killed after timeout (${input.timeoutMS}ms)`
  }
  if (input.aborted) {
    return 'process aborted'
  }
  if (input.writeError) {
    return `log write failed: ${input.writeError}`
  }
  if (input.exitCode !== 0) {
    return `process exited with code ${input.exitCode}`
  }
  return undefined
}

function dirName(path: string): string {
  const idx = path.lastIndexOf('/')
  if (idx <= 0) return '.'
  return path.slice(0, idx)
}

function buildCommitMessage(taskID: string, prompt: string): string {
  const title = extractTaskTitle(prompt)
  return title || `orca: task ${taskID}`
}

async function finalizeGitWorktree(
  worktreePath: string,
  commitMessage: string,
): Promise<{ diff: string; filesChanged: string[] }> {
  await gitOutput(worktreePath, ['add', '-A']).catch(() => '')
  const committed = await gitOutput(worktreePath, ['commit', '-m', commitMessage])
    .then(() => true)
    .catch(() => false)
  if (!committed) {
    return { diff: '', filesChanged: [] }
  }

  const diff = await gitOutput(worktreePath, ['diff', 'HEAD~1..HEAD']).catch(() => '')
  const filesChangedRaw = await gitOutput(worktreePath, ['diff', 'HEAD~1..HEAD', '--name-only']).catch(
    () => '',
  )

  return {
    diff,
    filesChanged: normalizeList(filesChangedRaw.split('\n')),
  }
}

function normalizeList(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []

  for (const value of values) {
    const normalized = value.trim()
    if (!normalized) continue
    if (seen.has(normalized)) continue
    seen.add(normalized)
    out.push(normalized)
  }

  return out
}

function filteredEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (key === 'CLAUDECODE') continue
    if (value === undefined) continue
    out[key] = value
  }
  return out
}

function extractTaskTitle(prompt: string): string {
  const normalized = prompt.replace(/\r/g, '')
  const taskMatch = normalized.match(/(?:^|\n)## Task\s*\n+([\s\S]*?)(?:\n## |\n---\n|$)/)
  if (!taskMatch) return ''

  const block = taskMatch[1] ?? ''
  for (const line of block.split('\n')) {
    const candidate = line.trim()
    if (!candidate) continue
    if (candidate.startsWith('#')) continue
    return candidate
  }

  return ''
}
