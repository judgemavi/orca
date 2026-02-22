import {
  useCallback,
  useEffect,
  useState,
} from 'react'
import { useWebSocket } from './hooks/useWebSocket'
import { ConsolePanel } from './components/console/ConsolePanel'
import { BoardView } from './components/board/BoardView'
import { OperationsIndicator } from './components/common/OperationsIndicator'
import { useWSQueryBridge } from './lib/wsQueryBridge'
import { api } from './api'
import type { WSEvent } from './types'

export default function App() {
  const [lastWSEvent, setLastWSEvent] = useState<WSEvent | null>(null)
  const [orchestratorId, setOrchestratorId] = useState<string | null>(null)

  useEffect(() => {
    api.listSessions().then((res) => {
      const orch = (res.sessions ?? []).find((s) => s.type === 'orchestrator')
      if (orch) setOrchestratorId(orch.id)
    })
  }, [])

  const onWSEvent = useWSQueryBridge(
    useCallback((event: WSEvent) => {
      setLastWSEvent(event)

      if (event.type === 'session.created' && String(event.data.type) === 'orchestrator') {
        setOrchestratorId(String(event.data.id ?? ''))
      }

      if (event.type === 'session.exited' && String(event.data.type) === 'orchestrator') {
        setOrchestratorId(null)
      }
    }, []),
  )

  useWebSocket(onWSEvent)

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-slate-700 bg-slate-900 px-4">
        <span className="px-3.5 py-1.5 text-sm font-medium text-slate-100">
          Pod
        </span>
        <div className="ml-auto">
          <OperationsIndicator />
        </div>
      </header>

      <main className="flex flex-1 overflow-hidden pb-10.5">
        <BoardView lastWSEvent={lastWSEvent} />
      </main>

      <ConsolePanel lastWSEvent={lastWSEvent} orchestratorId={orchestratorId} />
    </div>
  )
}
