import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTrigger,
} from '@tiny-bits/react-dialog'
import { api } from '../../api'
import type { WSEvent, WorkerOutputEvent } from '../../types'
import { ConsoleTab, type ConsoleLine } from './ConsoleTab'
import { TerminalPane } from '../terminal/TerminalPane'

type TabStatus = 'running' | 'done' | 'failed'

interface ConsoleTaskTab {
  taskId: string
  title: string
  tool: string
  status: TabStatus
  lines: ConsoleLine[]
  hydrated: boolean
}

interface Props {
  lastWSEvent: WSEvent | null
  orchestratorId: string | null
}

function parseStreamLine(raw: string): ConsoleLine {
  if (raw.startsWith('[stderr] ')) {
    return { raw: raw.slice('[stderr] '.length), stream: 'stderr' }
  }
  if (raw.startsWith('[stdout] ')) {
    return { raw: raw.slice('[stdout] '.length), stream: 'stdout' }
  }
  return { raw, stream: 'stdout' }
}

const DIALOG_CLS =
  'fixed! inset-4! top-14! bottom-16! mx-auto! w-4/5 h-3/5 rounded-lg! border! border-slate-600! bg-slate-900! p-0! shadow-2xl! m-0!'

function DialogChrome({
  title,
  children,
}: {
  title: string
  children?: React.ReactNode
}) {
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
      {children && (
        <div className="ml-auto flex items-center gap-2">{children}</div>
      )}
    </div>
  )
}

export function ConsolePanel({ lastWSEvent, orchestratorId }: Props) {
  const [tabs, setTabs] = useState<ConsoleTaskTab[]>([])
  const [showTimestamps, setShowTimestamps] = useState(false)
  const hydratingRef = useRef<Set<string>>(new Set())

  const ensureTab = useCallback(
    (taskId: string, base?: Partial<ConsoleTaskTab>) => {
      setTabs((prev) => {
        if (prev.some((t) => t.taskId === taskId)) return prev
        return [
          ...prev,
          {
            taskId,
            title: base?.title ?? `Task ${taskId.slice(0, 8)}`,
            tool: base?.tool ?? 'worker',
            status: base?.status ?? 'running',
            lines: base?.lines ?? [],
            hydrated: base?.hydrated ?? false,
          },
        ]
      })
    },
    [],
  )

  const updateTab = useCallback(
    (taskId: string, updater: (tab: ConsoleTaskTab) => ConsoleTaskTab) => {
      setTabs((prev) =>
        prev.map((tab) => (tab.taskId === taskId ? updater(tab) : tab)),
      )
    },
    [],
  )

  // Bootstrap: load running task tabs on mount
  useEffect(() => {
    Promise.all([
      api.listOperations({ type: 'run' }),
      api.listTasks(),
    ])
      .then(([opsRes, taskRes]) => {
        const hasRunning = (opsRes.operations ?? []).some(
          (op) => op.status === 'running',
        )
        if (!hasRunning) return
        const nextTabs: ConsoleTaskTab[] = []
        for (const task of taskRes.tasks ?? []) {
          if (
            task.status !== 'running' &&
            task.status !== 'review' &&
            task.status !== 'approved' &&
            task.status !== 'failed'
          ) {
            continue
          }
          const status: TabStatus =
            task.status === 'failed'
              ? 'failed'
              : task.status === 'approved'
                ? 'done'
                : 'running'
          nextTabs.push({
            taskId: task.id,
            title: task.title,
            tool: task.assigned_tool ?? 'worker',
            status,
            lines: [],
            hydrated: false,
          })
        }
        if (nextTabs.length === 0) return
        setTabs((prev) => {
          const seen = new Set(prev.map((t) => t.taskId))
          return [...prev, ...nextTabs.filter((t) => !seen.has(t.taskId))]
        })
      })
      .catch(() => {})
  }, [])

  // WS events
  useEffect(() => {
    if (!lastWSEvent) return

    if (lastWSEvent.type === 'worker.output') {
      const data = lastWSEvent.data as unknown as WorkerOutputEvent
      if (!data?.task_id) return
      ensureTab(data.task_id)
      updateTab(data.task_id, (tab) => {
        const stream: 'stdout' | 'stderr' =
          data.stream === 'stderr' ? 'stderr' : 'stdout'
        const next = [
          ...tab.lines,
          { raw: data.line ?? '', stream, ts: data.ts },
        ]
        return {
          ...tab,
          status:
            tab.status === 'failed' || tab.status === 'done'
              ? tab.status
              : 'running',
          lines: next.length > 2000 ? next.slice(-2000) : next,
        }
      })
      return
    }

    if (lastWSEvent.type === 'worker.done') {
      const taskID = String(lastWSEvent.data.task_id ?? '')
      const exitCode = Number(lastWSEvent.data.exit_code ?? -1)
      if (!taskID) return
      ensureTab(taskID)
      updateTab(taskID, (tab) => ({
        ...tab,
        status: exitCode === 0 ? 'done' : 'failed',
      }))
      return
    }

    if (lastWSEvent.type === 'task.updated') {
      const taskID = String(
        lastWSEvent.data.id ?? lastWSEvent.data.task_id ?? '',
      )
      if (!taskID) return
      const status = String(lastWSEvent.data.status ?? '')
      let nextStatus: TabStatus | null = null
      if (status === 'failed') nextStatus = 'failed'
      if (status === 'approved' || status === 'merged') nextStatus = 'done'
      if (status === 'running') nextStatus = 'running'
      if (!nextStatus) return
      ensureTab(taskID)
      updateTab(taskID, (tab) => ({
        ...tab,
        status:
          nextStatus === 'running' &&
          (tab.status === 'done' || tab.status === 'failed')
            ? tab.status
            : nextStatus,
      }))
      return
    }

    if (lastWSEvent.type === 'run.completed' || lastWSEvent.type === 'run.failed') {
      const fallback: TabStatus = lastWSEvent.type === 'run.failed' ? 'failed' : 'done'
      setTabs((prev) =>
        prev.map((tab) =>
          tab.status === 'running' ? { ...tab, status: fallback } : tab,
        ),
      )
    }
  }, [ensureTab, lastWSEvent, updateTab])

  const closeTab = useCallback((taskId: string) => {
    hydratingRef.current.delete(taskId)
    setTabs((prev) => prev.filter((t) => t.taskId !== taskId))
  }, [])

  const hydrateTab = useCallback(
    (taskId: string) => {
      if (hydratingRef.current.has(taskId)) return
      setTabs((prev) => {
        const tab = prev.find((t) => t.taskId === taskId)
        if (!tab || tab.hydrated) return prev
        hydratingRef.current.add(taskId)
        api
          .getTaskLogs(taskId, 2000)
          .then((lines) =>
            updateTab(taskId, (t) => ({
              ...t,
              lines: lines.map(parseStreamLine),
              hydrated: true,
            })),
          )
          .catch(() => updateTab(taskId, (t) => ({ ...t, hydrated: true })))
        return prev.map((t) =>
          t.taskId === taskId ? { ...t, hydrated: true } : t,
        )
      })
    },
    [updateTab],
  )

  return (
    <div className="fixed bottom-0 left-0 right-0 z-18 flex h-10.5 items-center gap-1 border-t border-slate-700 bg-slate-900 px-2.5">
      {/* Worker task tabs — each with its own independent Dialog instance */}
      {tabs.map((tab) => {
        return (
          <Dialog key={tab.taskId} modal>
            <DialogTrigger
              className="inline-flex max-w-55 items-center gap-1.5 rounded px-2.5 py-1 text-xs text-slate-200 transition hover:bg-slate-800"
              onClick={() => hydrateTab(tab.taskId)}
            >
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${
                  tab.status === 'running'
                    ? 'animate-pulse bg-emerald-500'
                    : tab.status === 'failed'
                      ? 'bg-rose-400'
                      : 'bg-slate-500'
                }`}
              />
              <span className="font-mono text-[11px] text-slate-400">
                {tab.tool}
              </span>
              <span className="overflow-hidden text-ellipsis whitespace-nowrap">
                {tab.title}
              </span>
              {tab.status !== 'running' && (
                <span
                  role="button"
                  tabIndex={0}
                  className="ml-0.5 shrink-0 text-slate-500 hover:text-slate-200"
                  onClick={(e) => {
                    e.stopPropagation()
                    closeTab(tab.taskId)
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter' && e.key !== ' ') return
                    e.preventDefault()
                    closeTab(tab.taskId)
                  }}
                >
                  ×
                </span>
              )}
            </DialogTrigger>

            <DialogContent className={DIALOG_CLS}>
              <div className="flex h-full flex-col overflow-hidden">
                <DialogChrome title={`${tab.tool} • ${tab.title}`}>
                  <button
                    type="button"
                    className="rounded border border-slate-600 px-2 py-0.5 text-[11px] text-slate-400 hover:text-slate-200"
                    onClick={() => setShowTimestamps((v) => !v)}
                  >
                    {showTimestamps ? 'Hide time' : 'Time'}
                  </button>
                  {tab.status !== 'running' && (
                    <DialogClose
                      className="rounded border border-slate-600 px-2 py-0.5 text-[11px] text-slate-400 hover:text-rose-400"
                      onClick={() => closeTab(tab.taskId)}
                    >
                      Close tab
                    </DialogClose>
                  )}
                </DialogChrome>
                <div className="min-h-0 flex-1">
                  <ConsoleTab
                    taskId={tab.taskId}
                    lines={tab.lines}
                    isActive
                    status={tab.status}
                    showTimestamps={showTimestamps}
                    onClear={() =>
                      updateTab(tab.taskId, (prev) => ({
                        ...prev,
                        lines: [],
                      }))
                    }
                  />
                </div>
              </div>
            </DialogContent>
          </Dialog>
        )
      })}

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
