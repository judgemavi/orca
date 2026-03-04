import { api } from '../api'
import { ChatPane } from './orchestrator/ChatPane'
import { Button } from './Button'

interface Props {
  orchestratorId?: string
}

export function OrchestratorSidebar({ orchestratorId }: Props) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      {orchestratorId ? (
        <ChatPane className="flex-1 min-h-0" />
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-3 text-muted">
          <span>No orchestrator session</span>
          <Button
            variant="primary"
            onClick={() => api.startOrchestrator().catch(() => { })}
          >
            Start Session
          </Button>
        </div>
      )}
    </div>
  )
}
