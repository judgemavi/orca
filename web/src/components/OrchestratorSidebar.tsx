import { useState } from 'react'
import { api } from '../api'
import { ChatPane } from './orchestrator/ChatPane'
import { TerminalPane } from './terminal/TerminalPane'
import { Button } from './Button'

interface Props {
  orchestratorId?: string
}

export function OrchestratorSidebar({ orchestratorId }: Props) {
  const [mode, setMode] = useState<'terminal' | 'chat'>('chat')

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b border-border-subtle px-3 py-2">
        <button
          type="button"
          className={[
            'rounded-md border px-2.5 py-1 text-xs font-medium',
            mode === 'chat'
              ? 'border-accent bg-accent/10 text-accent'
              : 'border-border-subtle text-muted hover:text-foreground',
          ].join(' ')}
          onClick={() => setMode('chat')}
        >
          Chat
        </button>
        <button
          type="button"
          className={[
            'rounded-md border px-2.5 py-1 text-xs font-medium',
            mode === 'terminal'
              ? 'border-accent bg-accent/10 text-accent'
              : 'border-border-subtle text-muted hover:text-foreground',
          ].join(' ')}
          onClick={() => setMode('terminal')}
        >
          Terminal
        </button>
      </div>
      {mode === 'chat' ? (
        <ChatPane className="flex-1 min-h-0" />
      ) : orchestratorId ? (
        <TerminalPane sessionId={orchestratorId} className="flex-1 min-h-0" />
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-3 text-muted">
          <span>No orchestrator session</span>
          <Button
            variant="primary"
            onClick={() => api.startOrchestrator().catch(() => {})}
          >
            Start Session
          </Button>
        </div>
      )}
    </div>
  )
}
