import { useCallback, useEffect, useState } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { Outlet, Link, createRootRoute } from '@tanstack/react-router'
import { Brain, ClipboardList, Moon, Settings, Sun, Terminal } from 'lucide-react'
import { Toaster } from 'sonner'
import { handleWSEvent } from '../lib/wsQueryBridge'
import { useWebSocket } from '../hooks/useWebSocket'
import { isKnownWSEvent } from '../types'
import { api } from '../api'
import { queryClient } from '../lib/queryClient'
import { OrchestratorSidebar } from '../components/OrchestratorSidebar'
import { Button } from '../components/Button'

const RootLayout = () => {
  const [orchestratorId, setOrchestratorId] = useState<string>()
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => {
    const saved = localStorage.getItem('orchestrator.sidebar.open')
    return saved === 'true'
  })
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

  useEffect(() => {
    localStorage.setItem('orchestrator.sidebar.open', String(sidebarOpen))
  }, [sidebarOpen])

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
        <div className="flex h-11 w-full items-center justify-between gap-2 px-4">
          <Link to="/" className="px-3 py-1.5 text-sm font-medium">
            Orca
          </Link>
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
            <Button asChild size="icon">
              <Link to="/queue" className="btn-icon" aria-label="Open queue">
                <ClipboardList size={14} />
              </Link>
            </Button>
            <Button
              size="icon"
              aria-label={
                sidebarOpen ? 'Close Orchestrator Sidebar' : 'Open Orchestrator Sidebar'
              }
              onClick={() => setSidebarOpen((current) => !current)}
            >
              <Terminal size={16} />
            </Button>
          </div>
        </div>
      </header>

      <div className="flex flex-1 min-h-0">
        <main className="flex flex-1 min-w-0 flex-col overflow-y-auto px-4">
          <div className="mx-auto w-full max-w-360">
            <Outlet />
          </div>
        </main>
        {sidebarOpen ? (
          <aside className="flex h-full w-[clamp(240px,32vw,400px)] shrink-0 flex-col border-l border-border-subtle bg-surface">
            <OrchestratorSidebar orchestratorId={orchestratorId} />
          </aside>
        ) : null}
      </div>
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
