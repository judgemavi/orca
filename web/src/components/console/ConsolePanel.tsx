import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTrigger,
} from '@tiny-bits/react-dialog'
import { api } from '../../api'
import { TerminalPane } from '../terminal/TerminalPane'

interface Props {
  orchestratorId: string | null
}

const DIALOG_CLS =
  'fixed! inset-4! top-14! bottom-16! mx-auto! w-4/5 h-3/5 rounded-lg! border! border-slate-600! bg-slate-900! p-0! shadow-2xl! m-0!'

function DialogChrome({ title }: { title: string }) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-slate-700 px-4">
      <div className="flex gap-1.5">
        <DialogClose
          aria-label="Close"
          className="group h-3 w-3 rounded-full bg-[#ff5f57] transition hover:brightness-110"
        >
          <svg
            className="h-3 w-3 opacity-0 group-hover:opacity-100"
            viewBox="0 0 12 12"
            fill="none"
          >
            <path
              d="M3 3l6 6M9 3l-6 6"
              stroke="#820005"
              strokeWidth="1.2"
              strokeLinecap="round"
            />
          </svg>
        </DialogClose>
      </div>
      <span className="font-mono text-xs text-slate-300">{title}</span>
    </div>
  )
}

export function ConsolePanel({ orchestratorId }: Props) {
  return (
    <div className="fixed bottom-0 left-0 right-0 z-18 flex h-10.5 items-center gap-1 border-t border-slate-700 bg-slate-900 px-2.5">
      <div className="flex-1" />

      {/* Orchestrator — permanent right tab */}
      <Dialog modal>
        <DialogTrigger className="inline-flex items-center gap-1.5 rounded bg-indigo-600 px-3 py-1 text-xs font-medium text-white transition hover:bg-indigo-500">
          <svg
            width="12"
            height="12"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="2" y="3" width="12" height="10" rx="2" />
            <path d="M5 14h6" />
          </svg>
          Orchestrator
        </DialogTrigger>
        <DialogContent className={DIALOG_CLS}>
          <div className="flex h-full flex-col overflow-hidden">
            <DialogChrome title="Orchestrator" />
            <div className="min-h-0 flex-1">
              {orchestratorId ? (
                <TerminalPane sessionId={orchestratorId} className="h-full" />
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-3 text-slate-500">
                  <span>No orchestrator session</span>
                  <button
                    type="button"
                    className="rounded bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500"
                    onClick={() => api.startOrchestrator().catch(() => {})}
                  >
                    Start Session
                  </button>
                </div>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
