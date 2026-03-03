import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { detectAction } from '../lib/orchestratorActions'
import {
  detectPhaseActions,
  parseToolResultPayload,
} from '../lib/orchestratorPhaseActions'
import { normalizeToolName } from '../lib/orchestratorRichContent'
import type { OrchestratorMessage } from '../types'
import { subscribeWS } from '../ws'

interface OrchestratorToolUseEvent {
  id?: string
  name?: string
  args?: unknown
}

interface OrchestratorToolResultEvent {
  tool_use_id?: string
  name?: string
  content?: unknown
  is_error?: boolean
}

interface OrchestratorDoneEvent {
  error?: string
}

interface ParsedSSEEvent {
  event: string
  data: string
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return 'Unknown error'
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function extractTaskIdFromJSON(text: string): string | null {
  try {
    const obj = JSON.parse(text)
    if (typeof obj?.task_id === 'string' && obj.task_id.trim()) return obj.task_id.trim()
    if (typeof obj?.task?.id === 'string' && obj.task.id.trim()) return obj.task.id.trim()
  } catch { /* not JSON */ }
  return null
}

function toPayloadString(
  value: unknown,
  fallback = '',
  pretty = false,
): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return fallback
  try {
    return JSON.stringify(value, null, pretty ? 2 : undefined)
  } catch {
    return fallback
  }
}

function parseSSEEvent(block: string): ParsedSSEEvent | null {
  const trimmed = block.trim()
  if (!trimmed) return null

  let event = 'message'
  const dataLines: string[] = []
  const lines = trimmed.split(/\r?\n/)
  for (const line of lines) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim()
      continue
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart())
    }
  }
  if (dataLines.length === 0) return null
  return { event, data: dataLines.join('\n') }
}

function parseJSON<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T
  } catch {
    return null
  }
}

async function getResponseError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown }
    if (typeof body.error === 'string' && body.error.trim()) return body.error
  } catch {
    // ignored: fallback error below
  }
  return `Request failed: ${response.status}`
}

export function useOrchestratorChat() {
  const [messages, setMessages] = useState<OrchestratorMessage[]>([])
  const [actedMessages, setActedMessages] = useState<Set<string>>(new Set())
  const [isLoadingHistory, setIsLoadingHistory] = useState(false)
  const [isStreaming, setIsStreaming] = useState(false)
  const [streamingText, setStreamingText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [deletedTaskIds, setDeletedTaskIds] = useState<Set<string>>(new Set())
  const localCounterRef = useRef(0)
  const requestAbortRef = useRef<AbortController | null>(null)
  const messagesRef = useRef<OrchestratorMessage[]>([])
  const actedMessagesRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  useEffect(() => {
    actedMessagesRef.current = actedMessages
  }, [actedMessages])

  const nextLocalMessage = useCallback(
    (
      role: OrchestratorMessage['role'],
      content: string,
      metadata: OrchestratorMessage['metadata'] = {},
    ): OrchestratorMessage => {
      const n = localCounterRef.current
      localCounterRef.current += 1
      return {
        id: `local-${Date.now()}-${n}`,
        session_id: 'local',
        role,
        content,
        metadata,
        created_at: new Date().toISOString(),
      }
    },
    [],
  )

  const loadHistory = useCallback(
    async (options?: { clearError?: boolean }) => {
      const clearError = options?.clearError ?? true
      if (clearError) setError(null)

      setIsLoadingHistory(true)
      try {
        const history = await api.getOrchestratorHistory()
        setMessages(history)
        // Mark assistant messages as acted if a user message follows them.
        const acted = new Set<string>()
        for (let i = 0; i < history.length; i += 1) {
          if (history[i].role !== 'assistant') continue
          if (!detectAction(history[i].content)) continue
          for (let j = i + 1; j < history.length; j += 1) {
            if (history[j].role === 'user') {
              acted.add(history[i].id)
              break
            }
            if (history[j].role === 'assistant') break
          }
        }
        for (let i = 0; i < history.length; i += 1) {
          const message = history[i]
          if (message.role !== 'tool_use') continue
          const toolUseID = asString(message.metadata.tool_use_id)
          let matchedToolResult: OrchestratorMessage | undefined

          for (let j = i + 1; j < history.length; j += 1) {
            const candidate = history[j]
            if (candidate.role !== 'tool_result') continue

            const resultToolUseID = asString(candidate.metadata.tool_use_id)
            const resultName = asString(candidate.metadata.name)
            const matchesByID =
              toolUseID !== '' &&
              resultToolUseID !== '' &&
              resultToolUseID === toolUseID
            const matchesByName =
              resultName !== '' && resultName === message.content
            if (!matchesByID && !matchesByName) continue

            matchedToolResult = candidate
            break
          }

          if (!matchedToolResult) continue
          if (Boolean(matchedToolResult.metadata.is_error)) continue

          const toolName = normalizeToolName(message.content)
          const payload = parseToolResultPayload(
            toolName,
            matchedToolResult.content,
          )
          const actionSet = detectPhaseActions(toolName, payload)
          if (!actionSet || actionSet.actions.length === 0) continue

          for (let j = i + 1; j < history.length; j += 1) {
            if (history[j].role === 'user') {
              acted.add(message.id)
              break
            }
          }
        }
        setActedMessages(acted)
      } catch (err) {
        setError(getErrorMessage(err))
      } finally {
        setIsLoadingHistory(false)
      }
    },
    [],
  )

  useEffect(() => {
    void loadHistory()
    return () => {
      requestAbortRef.current?.abort()
      requestAbortRef.current = null
    }
  }, [loadHistory])

  useEffect(() => {
    return subscribeWS((event) => {
      if (event.type !== 'task.deleted') return
      const id = typeof event.data.id === 'string' ? event.data.id : ''
      if (!id) return
      setDeletedTaskIds((prev) => {
        if (prev.has(id)) return prev
        const next = new Set(prev)
        next.add(id)
        return next
      })
    })
  }, [])

  const markMessageActed = useCallback((messageId: string) => {
    const id = messageId.trim()
    if (!id) return
    setActedMessages((prev) => {
      if (prev.has(id)) return prev
      const next = new Set(prev)
      next.add(id)
      return next
    })
  }, [])

  const markLatestActionedMessage = useCallback(() => {
    const currentMessages = messagesRef.current
    const currentActed = actedMessagesRef.current
    for (let i = currentMessages.length - 1; i >= 0; i -= 1) {
      const candidate = currentMessages[i]
      if (candidate.role !== 'assistant') continue
      if (currentActed.has(candidate.id)) continue
      if (!detectAction(candidate.content)) continue
      markMessageActed(candidate.id)
      break
    }
  }, [markMessageActed])

  const sendMessage = useCallback(
    async (text: string) => {
      const message = text.trim()
      if (!message || isStreaming) return
      markLatestActionedMessage()

      let currentAssistantId = `local-assistant-${Date.now()}-${localCounterRef.current}`
      localCounterRef.current += 1
      const userMessage = nextLocalMessage('user', message, {})

      setError(null)
      setStreamingText('')
      setIsStreaming(true)
      setMessages((prev) => [
        ...prev,
        userMessage,
        {
          id: currentAssistantId,
          session_id: 'local',
          role: 'assistant',
          content: '',
          metadata: {},
          created_at: new Date().toISOString(),
        },
      ])

      // Track all assistant segment IDs so we can clean up empty ones later.
      const assistantSegmentIds = new Set<string>([currentAssistantId])

      const abortController = new AbortController()
      requestAbortRef.current = abortController

      try {
        const response = await api.sendOrchestratorMessage(
          message,
          abortController.signal,
        )
        if (!response.ok) {
          throw new Error(await getResponseError(response))
        }
        if (!response.body) {
          throw new Error('Streaming response body is unavailable')
        }

        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        const handleEvent = (evt: ParsedSSEEvent) => {
          switch (evt.event) {
            case 'text': {
              setStreamingText((prev) => prev + evt.data)
              const targetId = currentAssistantId
              setMessages((prev) =>
                prev.map((msg) =>
                  msg.id === targetId
                    ? { ...msg, content: msg.content + evt.data }
                    : msg,
                ),
              )
              break
            }
            case 'tool_use': {
              const toolUse = parseJSON<OrchestratorToolUseEvent>(evt.data)
              if (!toolUse) break
              const argsStr = toPayloadString(toolUse.args, '{}', true)
              const tid = extractTaskIdFromJSON(argsStr)

              // Start a new assistant segment for text that comes after this tool call.
              const nextSegId = `local-assistant-${Date.now()}-${localCounterRef.current}`
              localCounterRef.current += 1
              assistantSegmentIds.add(nextSegId)
              currentAssistantId = nextSegId

              setMessages((prev) => [
                ...prev,
                nextLocalMessage('tool_use', toolUse.name ?? 'tool', {
                  tool_use_id: toolUse.id ?? '',
                  args: argsStr,
                  ...(tid ? { task_id: tid } : {}),
                }),
              ])
              break
            }
            case 'tool_result': {
              const toolResult = parseJSON<OrchestratorToolResultEvent>(
                evt.data,
              )
              if (!toolResult) break
              const contentStr = toPayloadString(toolResult.content, '')
              const tid = extractTaskIdFromJSON(contentStr)

              // Add tool_result, then the new assistant segment for post-tool text.
              const segId = currentAssistantId
              setMessages((prev) => [
                ...prev,
                nextLocalMessage(
                  'tool_result',
                  contentStr,
                  {
                    tool_use_id: toolResult.tool_use_id ?? '',
                    name: toolResult.name ?? '',
                    is_error: Boolean(toolResult.is_error),
                    ...(tid ? { task_id: tid } : {}),
                  },
                ),
                {
                  id: segId,
                  session_id: 'local',
                  role: 'assistant',
                  content: '',
                  metadata: {},
                  created_at: new Date().toISOString(),
                },
              ])
              break
            }
            case 'done': {
              const doneEvent = parseJSON<OrchestratorDoneEvent>(evt.data)
              if (doneEvent?.error) setError(doneEvent.error)
              break
            }
            default:
              break
          }
        }

        while (true) {
          const { value, done } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const blocks = buffer.split(/\r?\n\r?\n/)
          buffer = blocks.pop() ?? ''

          for (const block of blocks) {
            const parsed = parseSSEEvent(block)
            if (parsed) handleEvent(parsed)
          }
        }

        buffer += decoder.decode()
        if (buffer.trim()) {
          const parsed = parseSSEEvent(buffer)
          if (parsed) handleEvent(parsed)
        }
      } catch (err) {
        if (!(err instanceof DOMException && err.name === 'AbortError')) {
          setError(getErrorMessage(err))
        }
      } finally {
        requestAbortRef.current = null
        setIsStreaming(false)
        setStreamingText('')
        // Remove empty assistant segments created during streaming.
        setMessages((prev) =>
          prev.filter(
            (msg) =>
              !assistantSegmentIds.has(msg.id) || msg.content.trim() !== '',
          ),
        )
        if (!abortController.signal.aborted) {
          await loadHistory({ clearError: false })
        }
      }
    },
    [isStreaming, loadHistory, markLatestActionedMessage, nextLocalMessage],
  )

  const newSession = useCallback(async () => {
    requestAbortRef.current?.abort()
    requestAbortRef.current = null
    setIsStreaming(false)
    setStreamingText('')
    setError(null)
    setActedMessages(new Set())
    setDeletedTaskIds(new Set())
    try {
      await api.newOrchestratorSession()
      setMessages([])
    } catch (err) {
      setError(getErrorMessage(err))
    }
  }, [])

  const handleAction = useCallback(
    async (messageId: string, response: string) => {
      const trimmed = response.trim()
      if (!trimmed || isStreaming) return
      markMessageActed(messageId)
      await sendMessage(trimmed)
    },
    [isStreaming, markMessageActed, sendMessage],
  )

  return {
    messages,
    actedMessages,
    deletedTaskIds,
    isLoadingHistory,
    isStreaming,
    streamingText,
    error,
    loadHistory,
    sendMessage,
    handleAction,
    newSession,
  }
}
