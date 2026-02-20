import { useState, useCallback, useEffect, useRef } from 'react'
import { api } from '../api'
import type {
  ChatMessage,
  Block,
  WSEvent,
  SprintTaskStatus,
  Operation,
  ProposedTask,
} from '../types'

interface DecomposeResult {
  goal?: string
  proposed?: ProposedTask[]
  accepted?: boolean
  rejected?: boolean
}

function parseDecomposeResult(op: Operation): DecomposeResult | null {
  if (!op.result) return null
  try {
    return JSON.parse(op.result) as DecomposeResult
  } catch {
    return null
  }
}

function wsEventToBlocks(event: WSEvent): Block[] {
  switch (event.type) {
    case 'task.created':
    case 'task.updated':
      return [
        {
          type: 'task_card',
          data: { task: event.data.task as any, actions: [] },
        },
      ]
    case 'sprint.progress':
      return [
        {
          type: 'sprint_progress',
          data: {
            sprint_id: event.data.sprint_id as string,
            tasks: event.data.tasks as SprintTaskStatus[],
          },
        },
      ]
    case 'sprint.completed':
      return [
        {
          type: 'sprint_result',
          data: {
            sprint_id: event.data.sprint_id as string,
            results: event.data.results as any[],
            actions: ['review', 'integrate'],
          },
        },
      ]
    case 'escalation':
      return [
        {
          type: 'escalation',
          data: {
            message: event.data.message as string,
            task_id: event.data.task_id as string,
            actions: ['continue', 'abort'],
          },
        },
      ]
    case 'explore.completed':
      return [
        {
          type: 'text',
          data: {
            content: `Codebase explored. Context saved to ${event.data.path}`,
          },
        },
      ]
    case 'explore.failed':
      return [
        {
          type: 'text',
          data: { content: `Explore failed: ${event.data.error}` },
        },
      ]
    case 'plan.progress':
      return [
        {
          type: 'text',
          data: { content: String(event.data.message ?? 'Planning...') },
        },
      ]
    case 'plan.error':
      return [
        {
          type: 'text',
          data: {
            content: `Plan failed: ${String(event.data.error ?? 'unknown error')}`,
          },
        },
      ]
    case 'plan.proposed': {
      const sessionId = String(event.data.session_id ?? 'default')
      const operationId = String(
        event.data.operation_id ?? event.data.proposal_id ?? '',
      )
      const proposalId = String(
        event.data.proposal_id ??
          (operationId || `${sessionId}:${event.timestamp}`),
      )
      return [
        {
          type: 'plan_proposal',
          data: {
            goal: String(event.data.goal ?? ''),
            proposed_tasks: (event.data.tasks as any[]) ?? [],
            actions: ['Approve', 'Reject'],
            session_id: sessionId,
            proposal_id: proposalId,
            operation_id: operationId || undefined,
          },
        },
      ]
    }
    case 'decompose.started':
      return [
        { type: 'text', data: { content: 'Decomposing goal into tasks...' } },
      ]
    case 'decompose.completed':
      return [
        {
          type: 'plan_proposal',
          data: {
            goal: String(event.data.goal ?? 'Proposed tasks'),
            proposed_tasks: (event.data.proposed as any[]) ?? [],
            actions: ['Approve', 'Reject'],
            proposal_id: String(
              event.data.operation_id ?? `${event.timestamp}`,
            ),
            operation_id: String(event.data.operation_id ?? ''),
          },
        },
      ]
    case 'decompose.failed':
      return [
        {
          type: 'text',
          data: {
            content: `Decompose failed: ${String(event.data.error ?? 'unknown error')}`,
          },
        },
      ]
    default:
      if (event.data.message) {
        return [
          { type: 'text', data: { content: event.data.message as string } },
        ]
      }
      return []
  }
}

export function useChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [sessionId] = useState(() => crypto.randomUUID())
  const [loading, setLoading] = useState(false)
  const [actionedPlanProposals, setActionedPlanProposals] = useState<
    Set<string>
  >(new Set())
  const seenDecomposeOps = useRef<Set<string>>(new Set())

  const sendMessage = useCallback(
    async (text: string) => {
      const userMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        timestamp: new Date().toISOString(),
        content: text,
      }
      setMessages((prev) => [...prev, userMsg])
      setLoading(true)

      try {
        const response = await api.chat(text, sessionId)
        const assistantMsg: ChatMessage = {
          id: crypto.randomUUID(),
          role: 'assistant',
          timestamp: new Date().toISOString(),
          blocks: response.blocks,
        }
        setMessages((prev) => [...prev, assistantMsg])
      } catch (err) {
        const errMsg: ChatMessage = {
          id: crypto.randomUUID(),
          role: 'assistant',
          timestamp: new Date().toISOString(),
          blocks: [{ type: 'text', data: { content: `Error: ${err}` } }],
        }
        setMessages((prev) => [...prev, errMsg])
      } finally {
        setLoading(false)
      }
    },
    [sessionId],
  )

  useEffect(() => {
    api
      .listOperations({ type: 'decompose' })
      .then(({ operations }) => {
        const blocks: Block[] = []
        for (const op of operations ?? []) {
          if (seenDecomposeOps.current.has(op.id)) continue
          if (op.status === 'running') {
            seenDecomposeOps.current.add(op.id)
            blocks.push({
              type: 'text',
              data: {
                content: `Decomposing goal into tasks... (${op.id.slice(0, 8)})`,
              },
            })
            continue
          }
          if (op.status !== 'completed') continue

          const result = parseDecomposeResult(op)
          const proposed = result?.proposed ?? []
          if (
            (result?.accepted ?? false) ||
            (result?.rejected ?? false) ||
            proposed.length === 0
          ) {
            continue
          }
          seenDecomposeOps.current.add(op.id)
          blocks.push({
            type: 'plan_proposal',
            data: {
              goal: result?.goal ?? 'Proposed tasks',
              proposed_tasks: proposed,
              actions: ['Approve', 'Reject'],
              proposal_id: op.id,
              operation_id: op.id,
              session_id: op.target_id || undefined,
            },
          })
        }
        if (blocks.length > 0) {
          const msg: ChatMessage = {
            id: crypto.randomUUID(),
            role: 'assistant',
            timestamp: new Date().toISOString(),
            blocks,
          }
          setMessages((prev) => [...prev, msg])
        }
      })
      .catch(() => {})
  }, [])

  const handleWSEvent = useCallback((event: WSEvent) => {
    if (event.type === 'plan.proposed') {
      const opID = String(event.data.operation_id ?? '')
      if (opID && seenDecomposeOps.current.has(opID)) {
        return
      }
    }
    if (event.type.startsWith('decompose.')) {
      const opID = String(event.data.operation_id ?? '')
      if (opID) {
        if (event.type === 'decompose.completed') {
          seenDecomposeOps.current.add(opID)
        } else if (event.type === 'decompose.failed') {
          seenDecomposeOps.current.delete(opID)
        }
      }
    }
    const blocks = wsEventToBlocks(event)
    if (blocks.length > 0) {
      const msg: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        timestamp: event.timestamp,
        blocks,
      }
      setMessages((prev) => [...prev, msg])
    }
  }, [])

  const markPlanProposalActioned = useCallback((proposalId: string) => {
    setActionedPlanProposals((prev) => {
      const next = new Set(prev)
      next.add(proposalId)
      return next
    })
  }, [])

  return {
    messages,
    sendMessage,
    loading,
    handleWSEvent,
    sessionId,
    actionedPlanProposals,
    markPlanProposalActioned,
  }
}
