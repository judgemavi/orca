import { Dialog, DialogContent, DialogTrigger } from '@tiny-bits/react-dialog'
import { Terminal } from 'lucide-react'
import { TerminalPane } from './terminal/TerminalPane'
import { api } from '../api'
import { DialogChrome } from './DialogChrome'
import { Button } from './Button'

interface Props {
  orchestratorId?: string
}

export function OrchestratorDialog({ orchestratorId }: Props) {
  return (
    <Dialog modal>
      <Button size="icon" asChild>
        <DialogTrigger aria-label="Open Orchestrator">
          <Terminal size={16} />
        </DialogTrigger>
      </Button>
      <DialogContent className="dialog-content">
        <div className="dialog-content-inner">
          <DialogChrome title="Orchestrator" />
          {orchestratorId ? (
            <TerminalPane sessionId={orchestratorId} className="flex-1" />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-muted">
              <span>No orchestrator session</span>
              <button
                type="button"
                className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent/90"
                onClick={() => api.startOrchestrator().catch(() => {})}
              >
                Start Session
              </button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
