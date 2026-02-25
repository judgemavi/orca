import {
  useCallback,
  useEffect,
  useState,
} from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { Outlet, Link } from '@tanstack/react-router'
import { Settings } from 'lucide-react'
import { useWebSocket } from './hooks/useWebSocket'
import { ConsolePanel } from './components/console/ConsolePanel'
import { OperationsIndicator } from './components/common/OperationsIndicator'
import { useWSQueryBridge } from './lib/wsQueryBridge'
import { api } from './api'
import { queryClient } from './lib/queryClient'
import { WSContext } from './context/ws'
import type { WSEvent } from './types'

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AppLayout />
    </QueryClientProvider>
  )
}

function AppLayout() {
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
    <WSContext.Provider value={lastWSEvent}>
      <div className="flex h-screen flex-col overflow-hidden">
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-slate-700 bg-slate-900 px-4">
          <Link to='/' className="px-3.5 py-1.5 text-sm font-medium text-slate-100">
            Orca
          </Link>
          <div className="ml-auto flex items-center gap-2">
            <Link
              to="/config"
              className="rounded border border-[var(--border)] p-1.5 text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]"
              aria-label="Open config"
            >
              <Settings size={14} />
            </Link>
            <OperationsIndicator />
          </div>
        </header>

        <main className="flex flex-1 overflow-hidden pb-10.5">
          <Outlet />
        </main>

        <ConsolePanel orchestratorId={orchestratorId} />
      </div>
    </WSContext.Provider>
  )
}
