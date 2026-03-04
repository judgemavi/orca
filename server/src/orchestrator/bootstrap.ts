import { resolveModelForPhase } from '../config/config'
import { loadPrompt } from '../prompts/loader'
import { eq } from 'drizzle-orm'
import type { OrcaDrizzleDB } from '../db/connection'
import { orchestratorSessions } from '../db/schema'
import { toolDefinition, type DriverRegistry } from '../driver/registry'
import type { Driver, DriverCost, DriverEvent } from '../driver/types'
import type { ConfigStore } from '../store/config'
import { toErrorMessage } from '../shared/errors'

export interface OrchestratorSession {
  id: string
  tool: string
  model: string
  claude_session_id: string
  status: string
}

export interface SupervisorResolution {
  toolName: string
  driver: Driver
  model: string
}

export interface OrchestratorTurnResult {
  assistant: string
  sessionId: string
  cost: DriverCost | null
}

export const ORCHESTRATOR_ALLOWED_TOOLS = [
  'mcp__orca__tasks_list',
  'mcp__orca__tasks_get',
  'mcp__orca__tasks_create',
  'mcp__orca__tasks_update',
  'mcp__orca__tasks_delete',
  'mcp__orca__tasks_start',
  'mcp__orca__tasks_stop',
  'mcp__orca__tasks_resume',
  'mcp__orca__tasks_add_dependency',
  'mcp__orca__breakdown',
  'mcp__orca__tasks_plan_evaluate',
  'mcp__orca__tasks_plan_generate',
  'mcp__orca__tasks_approve_plan',
  'mcp__orca__tasks_request_plan_changes',
  'mcp__orca__tasks_approve',
  'mcp__orca__tasks_request_changes',
  'mcp__orca__ai_review',
  'mcp__orca__tasks_reviews',
  'mcp__orca__merge',
  'mcp__orca__tasks_merge',
  'mcp__orca__memory_list',
  'mcp__orca__memory_search',
  'mcp__orca__memory_query',
  'mcp__orca__memory_sync',
  'mcp__orca__memory_refresh',
  'mcp__orca__memory_status',
  'mcp__orca__interactions_list',
  'mcp__orca__interaction_get',
  'mcp__orca__explore',
  'mcp__orca__explore_status',
  'mcp__orca__project_status',
  'mcp__orca__config_get',
  'mcp__orca__models_list',
  'mcp__orca__worktree_cleanup',
  'mcp__orca__worktree_status',
  'mcp__orca__cost_status',
  'mcp__orca__quality_results',
  'mcp__orca__queue_list',
  'mcp__orca__queue_counts',
  'Read',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
]


export function buildSystemPrompt(basePrompt: string): string {
  return basePrompt.trim()
}

export async function writeMCPConfig(repoDir: string, driver: Driver): Promise<string> {
  const target = configTarget(driver.name())
  const configPath = resolvePath(repoDir, target.file)
  await Bun.$`mkdir -p ${dirName(configPath)}`

  const command = process.execPath || 'bun'
  const scriptPathRaw = process.argv[1]?.trim() || 'server/src/index.ts'
  const scriptPath = isAbsolutePath(scriptPathRaw)
    ? scriptPathRaw
    : `${process.cwd().replace(/\/+$/g, '')}/${scriptPathRaw}`
  const args = [scriptPath, 'mcp']
  const server = { command, args, cwd: repoDir }
  const existing = await Bun.file(configPath).text().catch(() => '')

  if (target.format === 'toml') {
    const next = upsertMCPServerTOML(existing, target.rootKey, target.serverKey, server)
    await Bun.write(configPath, next)
    return configPath
  }

  const next = upsertMCPServerJSON(existing, target.rootKey, target.serverKey, server)
  await Bun.write(configPath, next)
  return configPath
}

export async function resolveSupervisor(
  configStore: ConfigStore,
  registry: DriverRegistry,
): Promise<SupervisorResolution> {
  const config = await configStore.load()
  const toolName = config.orchestrator.supervisorTool || config.defaultTool || 'claude'
  const driver = toolDefinition(registry, toolName)
  if (!driver) {
    throw new Error(`supervisor tool not available: ${toolName}`)
  }

  const model = resolveModelForPhase(
    config,
    registry,
    '',
    toolName,
    config.orchestrator.supervisorModel || '',
  )
  if (!model.trim()) {
    throw new Error(`supervisor model could not be resolved for ${toolName}`)
  }

  return { toolName, driver, model }
}

export async function loadOrchestratorPrompt(repoDir: string): Promise<string> {
  const orchestrator = await loadPrompt(repoDir, 'orchestrator')
  const outputStyle = await loadPrompt(repoDir, 'outputStyle')
  const prompt = [orchestrator.trim(), outputStyle.trim()].filter(Boolean).join('\n\n')
  return buildSystemPrompt(prompt)
}

export async function runOrchestratorTurn(
  deps: {
    db: OrcaDrizzleDB
    repoDir: string
    configStore: ConfigStore
    registry: DriverRegistry
  },
  session: OrchestratorSession,
  message: string,
  onEvent: (event: DriverEvent) => void,
): Promise<OrchestratorTurnResult> {
  const resolved = await resolveSupervisor(deps.configStore, deps.registry)
  const mcpConfigPath = await writeMCPConfig(deps.repoDir, resolved.driver)
  const headlessOpts = {
    mcpConfig: mcpConfigPath,
    allowedTools: ORCHESTRATOR_ALLOWED_TOOLS,
  }

  const resumeSID = (session.claude_session_id ?? '').trim()
  let args: string[]

  if (resumeSID) {
    args = resolved.driver.resumeArgs(
      resumeSID,
      message,
      resolved.model,
      deps.repoDir,
      headlessOpts,
    )
  } else {
    const systemPrompt = await loadOrchestratorPrompt(deps.repoDir)
    const prompt = `${systemPrompt}\n\n${message}`
    args = resolved.driver.headlessArgs(prompt, resolved.model, deps.repoDir, headlessOpts)
  }

  const child = Bun.spawn({
    cmd: [resolved.driver.binary(), ...args],
    cwd: deps.repoDir,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: filteredEnv(process.env),
  })

  const events: DriverEvent[] = []
  const texts: string[] = []

  const emitEvent = (event: DriverEvent) => {
    events.push(event)
    if (event.type === 'text' && event.text?.trim()) {
      texts.push(event.text)
    }
    onEvent(event)
  }

  await Promise.all([
    consumeStream(child.stdout, 'stdout', resolved.driver, emitEvent),
    consumeStream(child.stderr, 'stderr', resolved.driver, emitEvent),
  ])

  await child.exited

  let sessionId = resolved.driver.parseSessionID(events) ?? ''
  if (!sessionId) {
    for (const ev of events) {
      if (ev.type === 'session' && ev.sessionID?.trim()) {
        sessionId = ev.sessionID.trim()
        break
      }
      if (ev.type === 'cost' && ev.sessionID?.trim()) {
        sessionId = ev.sessionID.trim()
      }
    }
  }

  if (sessionId) {
    await deps.db
      .update(orchestratorSessions)
      .set({ claudeSessionId: sessionId })
      .where(eq(orchestratorSessions.id, session.id))
  }

  let inputTokens = 0
  let outputTokens = 0
  let totalCost = 0
  for (const ev of events) {
    if (ev.type !== 'cost' || !ev.cost) continue
    inputTokens += Math.trunc(ev.cost.inputTokens)
    outputTokens += Math.trunc(ev.cost.outputTokens)
    totalCost += ev.cost.totalCost
  }
  const hasCost = inputTokens !== 0 || outputTokens !== 0 || totalCost !== 0

  const assistant = texts
    .map((t) => t.trim())
    .filter(Boolean)
    .join('\n')
    .trim()

  return {
    assistant,
    sessionId: sessionId || session.claude_session_id || '',
    cost: hasCost ? { inputTokens, outputTokens, totalCost } : null,
  }
}

async function consumeStream(
  stream: ReadableStream<Uint8Array> | null,
  source: 'stdout' | 'stderr',
  driver: Driver,
  emit: (event: DriverEvent) => void,
): Promise<void> {
  if (!stream) return

  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let pending = ''

  const processLine = (line: string) => {
    const cleaned = line.replace(/\r/g, '').trim()
    if (!cleaned) return

    if (source === 'stderr') {
      emit({ type: 'error', text: cleaned, raw: line })
      return
    }

    const parsed = driver.parseEvent(Buffer.from(line))
    if (parsed) {
      emit(parsed)
    }
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value || value.length === 0) continue

    pending += decoder.decode(value, { stream: true })
    let idx = pending.indexOf('\n')
    while (idx >= 0) {
      processLine(pending.slice(0, idx))
      pending = pending.slice(idx + 1)
      idx = pending.indexOf('\n')
    }
  }

  const tail = pending + decoder.decode()
  if (tail.trim()) {
    processLine(tail)
  }
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

function configTarget(name: string): {
  format: 'json' | 'toml'
  file: string
  rootKey: string
  serverKey: string
} {
  const normalized = name.trim().toLowerCase()
  if (normalized === 'codex') {
    return {
      format: 'toml',
      file: '.codex/config.toml',
      rootKey: 'mcp_servers',
      serverKey: 'orca',
    }
  }
  return {
    format: 'json',
    file: '.orca/mcp.json',
    rootKey: 'mcpServers',
    serverKey: 'orca',
  }
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[/\\]/.test(path)
}

function resolvePath(repoDir: string, rawPath: string): string {
  if (isAbsolutePath(rawPath)) return rawPath
  const repo = repoDir.replace(/\/+$/g, '')
  const rel = rawPath.replace(/^\.?\//, '')
  return `${repo}/${rel}`
}

function dirName(path: string): string {
  const idx = path.lastIndexOf('/')
  if (idx <= 0) return '.'
  return path.slice(0, idx)
}

function upsertMCPServerJSON(
  existingRaw: string,
  rootKeyPath: string,
  serverKey: string,
  server: { command: string; args: string[]; cwd: string },
): string {
  const root = parseJSONRoot(existingRaw)
  const container = ensureObjectPath(root, rootKeyPath)
  container[serverKey] = {
    command: server.command,
    args: [...server.args],
    cwd: server.cwd,
  }
  return `${JSON.stringify(root, null, 2)}\n`
}

function parseJSONRoot(raw: string): Record<string, unknown> {
  const trimmed = raw.trim()
  if (!trimmed) return {}

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (error) {
    throw new Error(`invalid MCP JSON config: ${toErrorMessage(error)}`)
  }
  if (!isObject(parsed)) {
    throw new Error('invalid MCP JSON config: root must be an object')
  }
  return parsed as Record<string, unknown>
}

function ensureObjectPath(root: Record<string, unknown>, keyPath: string): Record<string, unknown> {
  const parts = keyPath.split('.').map((part) => part.trim()).filter(Boolean)
  if (parts.length === 0) return root

  let cursor: Record<string, unknown> = root
  for (const part of parts) {
    const next = cursor[part]
    if (next == null) {
      const created: Record<string, unknown> = {}
      cursor[part] = created
      cursor = created
      continue
    }
    if (!isObject(next)) {
      throw new Error(`invalid MCP JSON config: key path "${keyPath}" is not an object at "${part}"`)
    }
    cursor = next as Record<string, unknown>
  }
  return cursor
}

function upsertMCPServerTOML(
  existingRaw: string,
  rootKey: string,
  serverKey: string,
  server: { command: string; args: string[]; cwd: string },
): string {
  const header = `[${rootKey}.${serverKey}]`
  const block = [
    header,
    `command = "${escapeTOML(server.command)}"`,
    `args = [${server.args.map((arg) => `"${escapeTOML(arg)}"`).join(', ')}]`,
    `cwd = "${escapeTOML(server.cwd)}"`,
  ]

  const normalized = existingRaw.replace(/\r\n/g, '\n')
  if (!normalized.trim()) {
    return `${block.join('\n')}\n`
  }

  const lines = normalized.split('\n')
  const headerIndex = lines.findIndex((line) => line.trim() === header)

  if (headerIndex < 0) {
    const base = normalized.endsWith('\n') ? normalized : `${normalized}\n`
    return `${base}\n${block.join('\n')}\n`
  }

  let bodyEnd = headerIndex + 1
  while (bodyEnd < lines.length && !isTOMLHeaderLine(lines[bodyEnd] ?? '')) {
    bodyEnd += 1
  }

  const preserved = lines
    .slice(headerIndex + 1, bodyEnd)
    .filter((line) => !isManagedTOMLKey(line))

  lines.splice(headerIndex, bodyEnd - headerIndex, ...block, ...preserved)
  return `${lines.join('\n').replace(/\s*$/g, '')}\n`
}

function isTOMLHeaderLine(line: string): boolean {
  return /^\s*\[[^\]]+\]\s*(#.*)?$/.test(line)
}

function isManagedTOMLKey(line: string): boolean {
  const stripped = line.replace(/#.*/g, '').trim()
  if (!stripped) return false
  const match = stripped.match(/^([A-Za-z0-9_.-]+)\s*=/)
  if (!match?.[1]) return false
  return match[1] === 'command' || match[1] === 'args' || match[1] === 'cwd'
}

function escapeTOML(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
