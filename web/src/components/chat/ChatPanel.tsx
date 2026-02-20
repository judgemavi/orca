import { useEffect, useRef } from 'react'
import type { ChatMessage as ChatMessageType } from '../../types'
import { ChatMessage } from './ChatMessage'
import { ChatInput } from './ChatInput'

interface Props {
  messages: ChatMessageType[]
  onSend: (text: string) => void
  loading: boolean
  sessionId: string
  actionedPlanProposals: Set<string>
  onPlanProposalActioned: (proposalId: string) => void
}

export function ChatPanel({
  messages,
  onSend,
  loading,
  sessionId,
  actionedPlanProposals,
  onPlanProposalActioned,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (el) {
      el.scrollTop = el.scrollHeight
    }
  }, [messages])

  // Action buttons in blocks send chat messages
  const handleAction = (action: string) => {
    onSend(action)
  }

  return (
    <div className="flex h-full w-full flex-col bg-slate-950">
      <div
        className="flex flex-1 flex-col gap-3 overflow-y-auto px-6 py-4"
        ref={scrollRef}
      >
        {messages.length === 0 && (
          <div className="flex flex-1 flex-col items-center justify-center gap-2">
            <div className="text-3xl font-bold text-slate-100">Pod</div>
            <div className="text-sm text-slate-400">
              Type <strong>help</strong> to see available commands, or describe
              what you want to build.
            </div>
          </div>
        )}
        {messages.map((msg) => (
          <ChatMessage
            key={msg.id}
            message={msg}
            onAction={handleAction}
            sessionId={sessionId}
            actionedPlanProposals={actionedPlanProposals}
            onPlanProposalActioned={onPlanProposalActioned}
          />
        ))}
        {loading && (
          <div className="flex gap-1 py-2">
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400 [animation-delay:0ms]" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400 [animation-delay:200ms]" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400 [animation-delay:400ms]" />
          </div>
        )}
      </div>
      <ChatInput onSend={onSend} disabled={loading} />
    </div>
  )
}
