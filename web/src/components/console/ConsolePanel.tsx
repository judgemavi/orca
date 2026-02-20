import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import { api } from '../../api'
import type { LogEntry, WSEvent, WorkerOutputEvent } from '../../types'
import { ConsoleTab, type ConsoleLine } from './ConsoleTab'
import { LogHistory } from './LogHistory'

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
}

const LS_EXPANDED = 'pod.console.expanded'
const LS_HEIGHT = 'pod.console.heightPct'

function parseStreamLine(raw: string): ConsoleLine {
  if (raw.startsWith('[stderr] ')) {
    return { raw: raw.slice('[stderr] '.length), stream: 'stderr' }
  }
  if (raw.startsWith('[stdout] ')) {
    return { raw: raw.slice('[stdout] '.length), stream: 'stdout' }
  }
  return { raw, stream: 'stdout' }
}

function clampSnap(percent: number): number {
  if (percent < 40) return 30
  if (percent < 60) return 50
  return 70
}

export function ConsolePanel({ lastWSEvent }: Props) {
  const [expanded, setExpanded] = useState<boolean>(
    () => localStorage.getItem(LS_EXPANDED) === '1',
  )
  const [heightPct, setHeightPct] = useState<number>(() => {
    const raw = Number(localStorage.getItem(LS_HEIGHT) ?? '50')
    if (!Number.isFinite(raw) || raw <= 0) return 50
    return raw
  })
  const [tabs, setTabs] = useState<ConsoleTaskTab[]>([])
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null)
  const [showTimestamps, setShowTimestamps] = useState(false)
  const [showHistory, setShowHistory] = useState(false)

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

  const hydrateTabs = useCallback(async () => {
    if (!expanded) return
    const current = tabs
    await Promise.all(
      current.map(async (tab) => {
        if (tab.hydrated) return
        try {
          const lines = await api.getTaskLogs(tab.taskId, 2000)
          updateTab(tab.taskId, (prev) => ({
            ...prev,
            lines: lines.map(parseStreamLine),
            hydrated: true,
          }))
        } catch {
          updateTab(tab.taskId, (prev) => ({ ...prev, hydrated: true }))
        }
      }),
    )
  }, [expanded, tabs, updateTab])

  useEffect(() => {
    localStorage.setItem(LS_EXPANDED, expanded ? '1' : '0')
  }, [expanded])

  useEffect(() => {
    localStorage.setItem(LS_HEIGHT, String(heightPct))
  }, [heightPct])

  useEffect(() => {
    Promise.all([
      api.listOperations({ type: 'sprint_start' }),
      api.listTasks(),
      api.getActiveSprint().catch(() => null),
    ])
      .then(([opsRes, taskRes, active]) => {
        const hasRunningSprintOp = (opsRes.operations ?? []).some(
          (op) => op.status === 'running',
        )
        if (!hasRunningSprintOp || !active) return

        const tasks = taskRes.tasks ?? []
        const taskMap = new Map((tasks ?? []).map((t) => [t.id, t]))

        const nextTabs: ConsoleTaskTab[] = []
        for (const id of active.task_ids ?? []) {
          const task = taskMap.get(id)
          if (!task) continue
          const status: TabStatus =
            task.status === 'failed'
              ? 'failed'
              : task.status === 'completed'
                ? 'done'
                : 'running'
          nextTabs.push({
            taskId: id,
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
          const merged = [...prev]
          for (const tab of nextTabs) {
            if (!seen.has(tab.taskId)) merged.push(tab)
          }
          return merged
        })
        setActiveTaskId(
          (prev) =>
            prev ??
            nextTabs.find((t) => t.status === 'running')?.taskId ??
            nextTabs[0].taskId,
        )
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!lastWSEvent) return

    if (lastWSEvent.type === 'sprint.started') {
      Promise.all([api.getActiveSprint(), api.listTasks()])
        .then(([active, taskRes]) => {
          if (!active) return
          const taskMap = new Map((taskRes.tasks ?? []).map((t) => [t.id, t]))
          for (const taskID of active.task_ids ?? []) {
            const task = taskMap.get(taskID)
            ensureTab(taskID, {
              title: task?.title ?? `Task ${taskID.slice(0, 8)}`,
              tool: task?.assigned_tool ?? 'worker',
              status: 'running',
            })
            setActiveTaskId(taskID)
          }
        })
        .catch(() => {})
      return
    }

    if (lastWSEvent.type === 'worker.output') {
      const data = lastWSEvent.data as unknown as WorkerOutputEvent
      if (!data?.task_id) return
      ensureTab(data.task_id)
      updateTab(data.task_id, (tab) => {
        const stream: 'stdout' | 'stderr' =
          data.stream === 'stderr' ? 'stderr' : 'stdout'
        const next = [
          ...tab.lines,
          {
            raw: data.line ?? '',
            stream,
            ts: data.ts,
          },
        ]
        return {
          ...tab,
          // Terminal states always win over late output lines.
          status:
            tab.status === 'failed' || tab.status === 'done'
              ? tab.status
              : 'running',
          lines: next.length > 2000 ? next.slice(next.length - 2000) : next,
        }
      })
      setActiveTaskId(data.task_id)
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
      if (status === 'completed' || status === 'merged') nextStatus = 'done'
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

    if (
      lastWSEvent.type === 'sprint.completed' ||
      lastWSEvent.type === 'sprint.failed'
    ) {
      const fallback: TabStatus =
        lastWSEvent.type === 'sprint.failed' ? 'failed' : 'done'
      setTabs((prev) =>
        prev.map((tab) =>
          tab.status === 'running' ? { ...tab, status: fallback } : tab,
        ),
      )
    }
  }, [ensureTab, lastWSEvent, updateTab])

  useEffect(() => {
    hydrateTabs()
  }, [hydrateTabs])

  const activeCount = useMemo(
    () => tabs.filter((t) => t.status === 'running').length,
    [tabs],
  )

  const startResize = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault()
    const onMove = (ev: MouseEvent) => {
      const pct = ((window.innerHeight - ev.clientY) / window.innerHeight) * 100
      setHeightPct(Math.min(80, Math.max(20, pct)))
    }
    const onUp = () => {
      setHeightPct((prev) => clampSnap(prev))
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const openHistoricalLog = async (entry: LogEntry) => {
    const taskId = entry.task_id
    const status: TabStatus = entry.task_status === 'failed' ? 'failed' : 'done'

    ensureTab(taskId, {
      title: entry.task_title ?? `Task ${taskId.slice(0, 8)}`,
      tool: 'history',
      status,
      hydrated: true,
    })

    try {
      const lines = await api.getTaskLogs(taskId, 2000)
      updateTab(taskId, (prev) => ({
        ...prev,
        title: entry.task_title ?? prev.title,
        tool: 'history',
        status,
        lines: lines.map(parseStreamLine),
        hydrated: true,
      }))
    } catch {
      updateTab(taskId, (prev) => ({
        ...prev,
        title: entry.task_title ?? prev.title,
        tool: 'history',
        status,
        hydrated: true,
      }))
    }

    setActiveTaskId(taskId)
    setShowHistory(false)
  }

  return (
    <section className="pointer-events-none fixed bottom-0 left-0 right-0 z-[18]">
      <button
        type="button"
        className="pointer-events-auto mx-auto flex h-[34px] w-full items-center justify-between border-t border-slate-700 bg-slate-800 px-3.5 font-mono text-xs text-slate-200"
        onClick={() => setExpanded((v) => !v)}
      >
        <span>Console</span>
        <span className="inline-flex h-[18px] min-w-[22px] items-center justify-center rounded-full bg-blue-600 px-1.5 text-[11px] text-white">
          {activeCount}
        </span>
      </button>

      {expanded && (
        <div
          className="pointer-events-auto flex flex-col border-t border-slate-700 bg-slate-900 shadow-[0_-8px_30px_rgba(0,0,0,0.35)]"
          style={{ height: `${heightPct}vh` }}
        >
          <div
            className="h-2.5 cursor-ns-resize border-b border-slate-700 bg-gradient-to-r from-slate-900 via-slate-800 to-slate-900"
            onMouseDown={startResize}
          />

          <div className="flex items-center gap-1.5 overflow-x-auto border-b border-slate-700 p-2">
            {tabs.map((tab) => (
              <button
                key={tab.taskId}
                type="button"
                className={`inline-flex min-w-[140px] items-center gap-2 rounded-md border px-2.5 py-1.5 ${activeTaskId === tab.taskId ? 'border-slate-500 bg-slate-700' : 'border-slate-600 bg-slate-800'} text-slate-200 max-[760px]:min-w-[100px]`}
                onClick={() => {
                  setShowHistory(false)
                  setActiveTaskId(tab.taskId)
                }}
              >
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${tab.status === 'running' ? 'bg-emerald-500' : tab.status === 'failed' ? 'bg-rose-400' : 'bg-slate-400'}`}
                />
                <span className="max-w-[220px] overflow-hidden text-ellipsis whitespace-nowrap max-[760px]:max-w-[120px]">
                  {tab.title}
                </span>
                <span className="text-[11px] text-slate-400">{tab.tool}</span>
                {tab.status !== 'running' && (
                  <span
                    role="button"
                    tabIndex={0}
                    className="ml-0.5 text-slate-300"
                    onClick={(e) => {
                      e.stopPropagation()
                      setTabs((prev) =>
                        prev.filter((t) => t.taskId !== tab.taskId),
                      )
                      setActiveTaskId((prev) =>
                        prev === tab.taskId ? null : prev,
                      )
                    }}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter' && e.key !== ' ') return
                      e.preventDefault()
                      setTabs((prev) =>
                        prev.filter((t) => t.taskId !== tab.taskId),
                      )
                      setActiveTaskId((prev) =>
                        prev === tab.taskId ? null : prev,
                      )
                    }}
                  >
                    ×
                  </span>
                )}
              </button>
            ))}
            <button
              type="button"
              className="rounded border border-slate-500 bg-transparent px-2 py-1 text-[11px] text-slate-200"
              onClick={() => setShowHistory((v) => !v)}
            >
              {showHistory ? 'Hide history' : 'History'}
            </button>
            <button
              type="button"
              className="rounded border border-slate-500 bg-transparent px-2 py-1 text-[11px] text-slate-200"
              onClick={() => setShowTimestamps((v) => !v)}
            >
              {showTimestamps ? 'Hide time' : 'Show time'}
            </button>
          </div>

          <div className="relative min-h-0 flex-1">
            {showHistory ? (
              <LogHistory onOpenLog={openHistoricalLog} />
            ) : (
              tabs.map((tab) => (
                <ConsoleTab
                  key={tab.taskId}
                  taskId={tab.taskId}
                  lines={tab.lines}
                  isActive={
                    activeTaskId === tab.taskId ||
                    (!activeTaskId && tabs[0]?.taskId === tab.taskId)
                  }
                  status={tab.status}
                  showTimestamps={showTimestamps}
                  onClear={() =>
                    updateTab(tab.taskId, (prev) => ({ ...prev, lines: [] }))
                  }
                />
              ))
            )}
          </div>
        </div>
      )}
    </section>
  )
}
