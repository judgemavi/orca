import { ChatPanel } from '../components/chat/ChatPanel'
import { useAppShellContext } from '../App'

export function ChatRoute() {
  const app = useAppShellContext()

  return (
    <ChatPanel
      messages={app.chat.messages}
      onSend={app.chat.sendMessage}
      loading={app.chat.loading}
      sessionId={app.chat.sessionId}
      actionedPlanProposals={app.chat.actionedPlanProposals}
      onPlanProposalActioned={app.chat.markPlanProposalActioned}
    />
  )
}
