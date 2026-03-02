import * as Dialog from '@radix-ui/react-dialog'
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
    <Dialog.Root modal>
      <Dialog.Trigger asChild>
        <Button size="icon" aria-label="Open Orchestrator">
          <Terminal size={16} />
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content className="dialog-content fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 w-[70vw] h-[70vh]">
          <div className="dialog-content-inner h-full">
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
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
