import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from 'react'
import { Link, Outlet } from '@tanstack/react-router'
import { useChat } from './hooks/useChat'
import { useAutopilot } from './hooks/useAutopilot'
import { useWebSocket } from './hooks/useWebSocket'
import { ConsolePanel } from './components/console/ConsolePanel'
import { useWSQueryBridge } from './lib/wsQueryBridge'
import type { WSEvent } from './types'

type ChatState = ReturnType<typeof useChat>
type AutopilotState = ReturnType<typeof useAutopilot>

interface AppShellContextValue {
  chat: ChatState
  autopilot: AutopilotState
  lastWSEvent: WSEvent | null
}

const AppShellContext = createContext<AppShellContextValue | null>(null)

export function useAppShellContext() {
  const value = useContext(AppShellContext)
  if (!value) {
    throw new Error(
      'useAppShellContext must be used within AppShellContext provider',
    )
  }
  return value
}

export default function App() {
  const tabClass =
    'inline-flex items-center rounded-md px-3.5 py-1.5 text-sm font-medium text-slate-400 transition hover:bg-slate-800 hover:text-slate-100'
  const tabActiveClass = `${tabClass} bg-slate-800 text-slate-100`
  const chat = useChat()
  const autopilot = useAutopilot()
  const [lastWSEvent, setLastWSEvent] = useState<WSEvent | null>(null)

  const onWSEvent = useWSQueryBridge(
    useCallback(
      (event: WSEvent) => {
        chat.handleWSEvent(event)
        autopilot.handleWSEvent(event)
        setLastWSEvent(event)
      },
      [autopilot, chat],
    ),
  )

  useWebSocket(onWSEvent)

  const contextValue = useMemo<AppShellContextValue>(
    () => ({
      chat,
      autopilot,
      lastWSEvent,
    }),
    [autopilot, chat, lastWSEvent],
  )

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-slate-700 bg-slate-900 px-4">
        <nav className="flex gap-0.5">
          <Link
            to="/"
            className={tabClass}
            activeProps={{ className: tabActiveClass }}
          >
            Board
          </Link>
          <Link
            to="/chat"
            className={tabClass}
            activeProps={{ className: tabActiveClass }}
          >
            Chat
          </Link>
          <Link
            to="/settings"
            className={tabClass}
            activeProps={{ className: tabActiveClass }}
          >
            Settings
          </Link>
        </nav>
        <span className="ml-auto font-mono text-xs tracking-[0.1em] text-slate-400">
          pod
        </span>
      </header>

      <main className="flex flex-1 overflow-hidden pb-[34px]">
        <AppShellContext.Provider value={contextValue}>
          <Outlet />
        </AppShellContext.Provider>
      </main>

      <ConsolePanel lastWSEvent={lastWSEvent} />
    </div>
  )
}
