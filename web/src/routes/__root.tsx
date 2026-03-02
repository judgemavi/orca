import { useCallback, useEffect, useState } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { Outlet, Link, createRootRoute } from '@tanstack/react-router'
import { Brain, Moon, Settings, Sun } from 'lucide-react'
import { Toaster } from 'sonner'
import { handleWSEvent } from '../lib/wsQueryBridge'
import { useWebSocket } from '../hooks/useWebSocket'
import { isKnownWSEvent } from '../types'
import { OperationsIndicator } from '../components/common/OperationsIndicator'
import { api } from '../api'
import { queryClient } from '../lib/queryClient'
import { OrchestratorDialog } from '../components/OrchestratorDialog'
import { Button } from '../components/Button'

const RootLayout = () => {
  const [orchestratorId, setOrchestratorId] = useState<string>()
  const [themePreference, setThemePreference] = useState<'light' | 'dark'>(
    () => {
      const saved = localStorage.getItem('theme')
      if (saved === 'light' || saved === 'dark') return saved
      return window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
    },
  )

  useEffect(() => {
    api.listSessions().then((res) => {
      const orch = (res ?? []).find((s) => s.type === 'orchestrator')
      if (orch) setOrchestratorId(orch.id)
    })
  }, [])

  const ThemeIcon = themePreference === 'light' ? Sun : Moon

  useEffect(() => {
    const root = document.documentElement
    localStorage.setItem('theme', themePreference)
    root.classList.remove(themePreference === 'light' ? 'dark' : 'light')
    root.classList.add(themePreference)
  }, [themePreference])

  useWebSocket(
    useCallback((event: Parameters<typeof handleWSEvent>[1]) => {
      handleWSEvent(queryClient, event)
      if (!isKnownWSEvent(event)) return

      if (
        event.type === 'session.created' &&
        event.data.type === 'orchestrator'
      ) {
        setOrchestratorId(event.data.id)
      }
      if (
        event.type === 'session.exited' &&
        event.data.type === 'orchestrator'
      ) {
        setOrchestratorId(undefined)
      }
    }, []),
  )

  const cycleTheme = () => {
    setThemePreference((current) => {
      const next = current === 'light' ? 'dark' : 'light'
      return next
    })
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <header className="bg-surface border-b border-border-subtle">
        <div className="flex h-11 justify-between items-center gap-2 px-4 max-w-360 mx-auto">
          <Link to="/" className="px-3 py-1.5 text-sm font-medium">
            Orca
          </Link>
          <OperationsIndicator />
          <div className="flex items-center gap-2">
            <Button onClick={cycleTheme} size="icon" aria-label="Toggle theme">
              <ThemeIcon size={14} />
            </Button>
            <Button asChild size="icon">
              <Link
                to="/memory"
                className="rounded border border-border-subtle px-2.5 py-1 text-xs font-medium hover:no-underline"
              >
                <Brain size={14} />
              </Link>
            </Button>
            <Button asChild size="icon">
              <Link to="/config" className="btn-icon" aria-label="Open config">
                <Settings size={14} />
              </Link>
            </Button>
            <OrchestratorDialog orchestratorId={orchestratorId} />
          </div>
        </div>
      </header>

      <main className="flex flex-col flex-1 max-w-360 mx-auto w-full px-4">
        <Outlet />
      </main>
      <Toaster theme={themePreference} position="bottom-center" richColors />
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
