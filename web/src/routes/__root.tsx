import { useCallback, useEffect, useState } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { Outlet, Link, createRootRoute } from '@tanstack/react-router'
import { Settings } from 'lucide-react'
import { Toaster } from 'sonner'
import { handleWSEvent } from '../lib/wsQueryBridge'
import { wsEvents, useWSSubscribe } from '../lib/wsEvents'
import { useWebSocket } from '../hooks/useWebSocket'
import { OperationsIndicator } from '../components/common/OperationsIndicator'
import { ConsolePanel } from '../components/console/ConsolePanel'
import { api } from '../api'
import { queryClient } from '../lib/queryClient'

const RootLayout = () => {
  const [orchestratorId, setOrchestratorId] = useState<string | null>(null)

  useEffect(() => {
    api.listSessions().then((res) => {
      const orch = (res.sessions ?? []).find((s) => s.type === 'orchestrator')
      if (orch) setOrchestratorId(orch.id)
    })
  }, [])

  const onWSEvent = useCallback(
    (event: Parameters<typeof handleWSEvent>[1]) => {
      handleWSEvent(queryClient, event)
      wsEvents.emit(event)
    },
    [],
  )

  useWebSocket(onWSEvent)

  useWSSubscribe(
    useCallback((event) => {
      if (
        event.type === 'session.created' &&
        String(event.data.type) === 'orchestrator'
      ) {
        setOrchestratorId(String(event.data.id ?? ''))
      }
      if (
        event.type === 'session.exited' &&
        String(event.data.type) === 'orchestrator'
      ) {
        setOrchestratorId(null)
      }
    }, []),
  )

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-slate-700 bg-slate-900 px-4">
        <Link
          to="/"
          className="px-3.5 py-1.5 text-sm font-medium text-slate-100"
        >
          Orca
        </Link>
        <div className="ml-auto flex items-center gap-2">
          <Link
            to="/config"
            className="rounded border p-1.5  "
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
      <Toaster theme="dark" position="bottom-center" richColors />
    </div>
  )
}

export const Route = createRootRoute({
  component: () => (
    <QueryClientProvider client={queryClient}>
      <RootLayout />
    </QueryClientProvider>
  ),
})
