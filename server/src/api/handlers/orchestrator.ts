import { Hono } from 'hono'
import { asc, desc, eq } from 'drizzle-orm'
import type { OrcaDrizzleDB } from '../../db/connection'
import * as schema from '../../db/schema'
import type { DriverRegistry } from '../../driver/registry'
import type { DriverEvent } from '../../driver/types'
import {
  resolveSupervisor,
  runOrchestratorTurn,
  type OrchestratorSession,
} from '../../orchestrator/bootstrap'
import type { ConfigStore } from '../../store/config'
import type { EventSink } from '../ws'
import { parseBody, safeErrorMessage } from './utils'

interface SessionRow {
  id: string
  tool: string
  model: string
  claude_session_id: string
  status: string
  createdAt: string
}

interface MessageRow {
  id: string
  sessionId: string
  role: 'user' | 'assistant' | 'tool_use' | 'tool_result'
  content: string
  metadata: unknown
  createdAt: string
}

interface OrchestratorStreamState {
  pendingAssistantText: string
  sawStreamEvent: boolean
  lastAssistantMessageID: string
  lastTaskID: string
  closed: boolean
}

export function registerOrchestratorHandlers(
  app: Hono,
  db: OrcaDrizzleDB,
  sink: EventSink,
  configStore: ConfigStore,
  repoDir: string,
  registry: DriverRegistry,
) {
  app.post('/orchestrator/start', async (c) => {
    const resolved = await resolveSupervisor(configStore, registry)
    const session = await ensureActiveSession(db, {
      tool: resolved.toolName,
      model: resolved.model,
    })
    sink.broadcast('session.created', {
      id: session.id,
      type: 'orchestrator',
      tool: session.tool,
      taskId: '',
      exitCode: 0,
    })
    return c.json({ data: { status: 'started', sessionId: session.id } })
  })

  app.post('/orchestrator/chat/new', async (c) => {
    const resolved = await resolveSupervisor(configStore, registry)
    await db
      .update(schema.orchestratorSessions)
      .set({ status: 'closed' })
      .where(eq(schema.orchestratorSessions.status, 'active'))

    const id = crypto.randomUUID()
    await db.insert(schema.orchestratorSessions).values({
      id,
      tool: resolved.toolName,
      model: resolved.model,
      claudeSessionId: '',
      status: 'active',
    })

    sink.broadcast('orchestrator.session.new', { id })
    return c.json({ data: { id } })
  })

  app.get('/orchestrator/chat/history', async (c) => {
    const session = await getActiveSession(db)
    if (!session) return c.json({ data: [] })

    const rows = await db
      .select({
        id: schema.orchestratorMessages.id,
        sessionId: schema.orchestratorMessages.sessionId,
        role: schema.orchestratorMessages.role,
        content: schema.orchestratorMessages.content,
        metadata: schema.orchestratorMessages.metadata,
        createdAt: schema.orchestratorMessages.createdAt,
      })
      .from(schema.orchestratorMessages)
      .where(eq(schema.orchestratorMessages.sessionId, session.id))
      .orderBy(asc(schema.orchestratorMessages.createdAt))

    const messages = rows.map((row) => ({
      id: row.id,
      sessionId: row.sessionId,
      role: row.role,
      content: row.content,
      metadata: parseJSON(row.metadata),
      createdAt: row.createdAt,
    }))

    return c.json({ data: messages })
  })

  app.post('/orchestrator/chat', async (c) => {
    try {
      const body = await parseBody<{ message?: string }>(c.req)
      const message = body.message?.trim() ?? ''
      if (!message) {
        return c.json({ error: 'message is required' }, 400)
      }

      const resolved = await resolveSupervisor(configStore, registry)
      const session = await ensureActiveSession(db, {
        tool: resolved.toolName,
        model: resolved.model,
      })

      const userID = crypto.randomUUID()
      await db.insert(schema.orchestratorMessages).values({
        id: userID,
        sessionId: session.id,
        role: 'user',
        content: message,
        metadata: '{}',
      })
      sink.broadcast('orchestrator.chat.message', { sessionId: session.id })

      const stream = new ReadableStream<string>({
        start(controller) {
          void (async () => {
            const state = createOrchestratorStreamState()
            try {
              const result = await runOrchestratorTurn(
                { db, repoDir, configStore, registry },
                session,
                message,
                (event) => {
                  void publishEvent(db, session.id, controller, event, state, sink)
                },
              )

              const trailingAssistantID = await flushAssistantText(
                db,
                session.id,
                state,
                result.sessionId ? { sessionId: result.sessionId } : {},
              )
              let assistantID = trailingAssistantID || state.lastAssistantMessageID
              if (!assistantID && !state.sawStreamEvent) {
                assistantID = await insertAssistantMessage(
                  db,
                  session.id,
                  result.assistant.trim() || 'No output received from supervisor process.',
                  result.sessionId ? { sessionId: result.sessionId } : {},
                )
              }

              if (assistantID) {
                sink.broadcast('orchestrator.chat.message', {
                  sessionId: session.id,
                  user_message_id: userID,
                  assistant_message_id: assistantID,
                })
              }

              writeSSEJSON(controller, 'done', {
                sessionId: result.sessionId || '',
                cost: result.cost ?? null,
              }, state)
              state.closed = true
              try { controller.close() } catch {}
            } catch (error) {
              writeSSEJSON(controller, 'error', { error: safeErrorMessage(error) }, state)
              state.closed = true
              try { controller.close() } catch {}
            }
          })()
        },
      })

      c.header('Content-Type', 'text/event-stream')
      c.header('Cache-Control', 'no-cache')
      c.header('Connection', 'keep-alive')
      return c.body(stream)
    } catch (error) {
      return c.json({ error: safeErrorMessage(error) }, 500)
    }
  })
}

async function publishEvent(
  db: OrcaDrizzleDB,
  sessionID: string,
  controller: ReadableStreamDefaultController<string>,
  event: DriverEvent,
  state: OrchestratorStreamState,
  sink?: EventSink,
) {
  if (event.type === 'text') {
    const payload = (event.text ?? '').replace(/\r/g, '')
    if (!payload) return
    state.sawStreamEvent = true
    state.pendingAssistantText += payload
    writeSSEJSON(controller, 'text', payload, state)
    return
  }

  if (event.type === 'tool_use') {
    state.sawStreamEvent = true
    await flushAssistantText(db, sessionID, state)

    const id = event.toolUseID?.trim() || crypto.randomUUID()
    const name = event.toolName?.trim() || 'tool'
    const args = event.toolInput ?? {}
    const argsText = payloadToString(args)
    const taskID = extractTaskID(args)

    if (taskID) {
      state.lastTaskID = taskID
    }
    await db.insert(schema.orchestratorMessages).values({
      id: crypto.randomUUID(),
      sessionId: sessionID,
      role: 'tool_use',
      content: name,
      metadata: JSON.stringify({
        tool_use_id: id,
        name,
        args: argsText,
        tool_name: name,
        tool_input: args,
        ...(taskID ? { taskId: taskID } : {}),
      }),
    })
    sink?.broadcast('orchestrator.chat.message', { sessionId: sessionID })

    writeSSEJSON(controller, 'tool_use', { id, name, args }, state)
    return
  }

  if (event.type === 'tool_result') {
    state.sawStreamEvent = true
    const toolUseID = event.toolUseID?.trim() || ''
    const name = event.toolName?.trim() || ''
    const content = event.toolResult ?? ''
    const contentText = payloadToString(content)
    const taskID = extractTaskID(content)

    if (taskID) {
      state.lastTaskID = taskID
    }
    await db.insert(schema.orchestratorMessages).values({
      id: crypto.randomUUID(),
      sessionId: sessionID,
      role: 'tool_result',
      content: contentText,
      metadata: JSON.stringify({
        tool_use_id: toolUseID,
        name,
        tool_name: name,
        tool_result: contentText,
        is_error: Boolean(event.isError),
        isError: Boolean(event.isError),
        ...(taskID ? { taskId: taskID } : {}),
      }),
    })
    sink?.broadcast('orchestrator.chat.message', { sessionId: sessionID })

    writeSSEJSON(controller, 'tool_result', {
      tool_use_id: toolUseID,
      name,
      content,
      is_error: Boolean(event.isError),
    }, state)
    return
  }

  if (event.type === 'error') {
    const message = (event.text ?? '').trim()
    if (!message) return
    state.sawStreamEvent = true
    state.pendingAssistantText += state.pendingAssistantText ? `\n${message}` : message
    writeSSEJSON(controller, 'text', message, state)
  }
}

async function getActiveSession(db: OrcaDrizzleDB): Promise<SessionRow | null> {
  const rows = await db
    .select({
      id: schema.orchestratorSessions.id,
      tool: schema.orchestratorSessions.tool,
      model: schema.orchestratorSessions.model,
      claude_session_id: schema.orchestratorSessions.claudeSessionId,
      status: schema.orchestratorSessions.status,
      createdAt: schema.orchestratorSessions.createdAt,
    })
    .from(schema.orchestratorSessions)
    .where(eq(schema.orchestratorSessions.status, 'active'))
    .orderBy(desc(schema.orchestratorSessions.createdAt))
    .limit(1)
  return rows[0] ?? null
}

async function ensureActiveSession(
  db: OrcaDrizzleDB,
  desired: { tool: string; model: string },
): Promise<OrchestratorSession> {
  const current = await getActiveSession(db)
  if (current && current.tool === desired.tool && current.model === desired.model) {
    return current
  }

  if (current) {
    await db
      .update(schema.orchestratorSessions)
      .set({ status: 'closed' })
      .where(eq(schema.orchestratorSessions.id, current.id))
  }

  const id = crypto.randomUUID()
  await db.insert(schema.orchestratorSessions).values({
    id,
    tool: desired.tool,
    model: desired.model,
    claudeSessionId: '',
    status: 'active',
  })

  const insertedRows = await db
    .select({
      id: schema.orchestratorSessions.id,
      tool: schema.orchestratorSessions.tool,
      model: schema.orchestratorSessions.model,
      claude_session_id: schema.orchestratorSessions.claudeSessionId,
      status: schema.orchestratorSessions.status,
      createdAt: schema.orchestratorSessions.createdAt,
    })
    .from(schema.orchestratorSessions)
    .where(eq(schema.orchestratorSessions.id, id))
    .limit(1)
  const inserted = insertedRows[0] ?? null
  if (!inserted) {
    throw new Error(`failed to create orchestrator session ${id}`)
  }
  return inserted
}

function parseJSON(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  if (typeof value !== 'string') {
    return {}
  }
  try {
    const parsed = JSON.parse(value)
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, unknown>
    }
    return {}
  } catch {
    return {}
  }
}

function payloadToString(value: unknown): string {
  if (typeof value === 'string') return value
  if (value == null) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function createOrchestratorStreamState(): OrchestratorStreamState {
  return {
    pendingAssistantText: '',
    sawStreamEvent: false,
    lastAssistantMessageID: '',
    lastTaskID: '',
    closed: false,
  }
}

async function flushAssistantText(
  db: OrcaDrizzleDB,
  sessionID: string,
  state: OrchestratorStreamState,
  metadata: Record<string, unknown> = {},
): Promise<string> {
  const segment = state.pendingAssistantText.trim()
  state.pendingAssistantText = ''
  if (!segment) return ''

  const merged = {
    ...metadata,
    ...(state.lastTaskID ? { taskId: state.lastTaskID } : {}),
  }
  const id = await insertAssistantMessage(db, sessionID, segment, merged)
  state.lastAssistantMessageID = id
  return id
}

async function insertAssistantMessage(
  db: OrcaDrizzleDB,
  sessionID: string,
  content: string,
  metadata: Record<string, unknown> = {},
): Promise<string> {
  const id = crypto.randomUUID()
  await db.insert(schema.orchestratorMessages).values({
    id,
    sessionId: sessionID,
    role: 'assistant',
    content,
    metadata: JSON.stringify(metadata),
  })
  return id
}

function writeSSEJSON(
  controller: ReadableStreamDefaultController<string>,
  event: string,
  payload: unknown,
  state?: OrchestratorStreamState,
) {
  if (state?.closed) return
  try {
    controller.enqueue(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
  } catch {
    if (state) state.closed = true
  }
}

function extractTaskID(value: unknown): string {
  if (typeof value === 'string') {
    return extractTaskIDFromString(value)
  }
  try {
    return extractTaskIDFromString(JSON.stringify(value))
  } catch {
    return ''
  }
}

function extractTaskIDFromString(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { taskId?: unknown; task?: { id?: unknown } }
    if (typeof parsed.taskId === 'string' && parsed.taskId.trim()) {
      return parsed.taskId.trim()
    }
    if (typeof parsed.task?.id === 'string' && parsed.task.id.trim()) {
      return parsed.task.id.trim()
    }
  } catch {
    // Ignore non-JSON payloads.
  }
  return ''
}
