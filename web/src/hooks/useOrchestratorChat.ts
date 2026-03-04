import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { OrchestratorMessage } from '../types'

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

function extractTaskIdFromJSON(text: string): string | null {
  try {
    const obj = JSON.parse(text)
    if (typeof obj?.taskId === 'string' && obj.taskId.trim()) return obj.taskId.trim()
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

function parseTextChunk(value: string): string {
  const parsed = parseJSON<unknown>(value)
  if (typeof parsed === 'string') return parsed
  if (parsed && typeof parsed === 'object' && typeof (parsed as { text?: unknown }).text === 'string') {
    return (parsed as { text: string }).text
  }
  return value
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
  const [isLoadingHistory, setIsLoadingHistory] = useState(false)
  const [isStreaming, setIsStreaming] = useState(false)
  const [streamingText, setStreamingText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const localCounterRef = useRef(0)
  const requestAbortRef = useRef<AbortController | null>(null)

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
        sessionId: 'local',
        role,
        content,
        metadata,
        createdAt: new Date().toISOString(),
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

  const sendMessage = useCallback(
    async (text: string) => {
      const message = text.trim()
      if (!message || isStreaming) return

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
          sessionId: 'local',
          role: 'assistant',
          content: '',
          metadata: {},
          createdAt: new Date().toISOString(),
        },
      ])

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
              const text = parseTextChunk(evt.data)
              if (!text) break
              setStreamingText((prev) => prev + text)
              const targetId = currentAssistantId
              setMessages((prev) =>
                prev.map((msg) =>
                  msg.id === targetId
                    ? { ...msg, content: msg.content + text }
                    : msg,
                ),
              )
              break
            }
            case 'tool_use': {
              const toolUse = parseJSON<OrchestratorToolUseEvent>(evt.data)
              if (!toolUse) break

              // Start a new assistant segment for text after this tool call.
              const nextSegId = `local-assistant-${Date.now()}-${localCounterRef.current}`
              localCounterRef.current += 1
              assistantSegmentIds.add(nextSegId)
              currentAssistantId = nextSegId

              const argsStr = toPayloadString(toolUse.args, '{}', true)
              const tid = extractTaskIdFromJSON(argsStr)
              setMessages((prev) => [
                ...prev,
                nextLocalMessage('tool_use', toolUse.name ?? 'tool', {
                  tool_use_id: toolUse.id ?? '',
                  args: argsStr,
                  ...(tid ? { taskId: tid } : {}),
                }),
              ])
              break
            }
            case 'tool_result': {
              const toolResult = parseJSON<OrchestratorToolResultEvent>(evt.data)
              if (!toolResult) break
              const contentStr = toPayloadString(toolResult.content, '')
              const tid = extractTaskIdFromJSON(contentStr)

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
                    ...(tid ? { taskId: tid } : {}),
                  },
                ),
                {
                  id: segId,
                  sessionId: 'local',
                  role: 'assistant',
                  content: '',
                  metadata: {},
                  createdAt: new Date().toISOString(),
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
    [isStreaming, loadHistory, nextLocalMessage],
  )

  const newSession = useCallback(async () => {
    requestAbortRef.current?.abort()
    requestAbortRef.current = null
    setIsStreaming(false)
    setStreamingText('')
    setError(null)
    try {
      await api.newOrchestratorSession()
      setMessages([])
    } catch (err) {
      setError(getErrorMessage(err))
    }
  }, [])

  return {
    messages,
    isLoadingHistory,
    isStreaming,
    streamingText,
    error,
    loadHistory,
    sendMessage,
    newSession,
  }
}
