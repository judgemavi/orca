import { useEffect, useMemo, useRef, useState } from 'react'
import { parseLogBlocks } from '../../lib/logParser'
import { LogBlockRenderer } from './LogBlockRenderer'

export interface ConsoleLine {
  raw: string
  stream: 'stdout' | 'stderr'
  ts?: string
}

interface Props {
  taskId: string
  lines: ConsoleLine[]
  isActive: boolean
  status: 'running' | 'done' | 'failed'
  showTimestamps: boolean
  onClear: () => void
}

export function ConsoleTab({
  taskId,
  lines,
  isActive,
  status,
  showTimestamps,
  onClear,
}: Props) {
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const [stickyBottom, setStickyBottom] = useState(true)

  const visibleLines = useMemo(() => {
    if (lines.length <= 2000) return lines
    return lines.slice(lines.length - 2000)
  }, [lines])
  const blocks = useMemo(() => parseLogBlocks(visibleLines), [visibleLines])

  useEffect(() => {
    if (!isActive || !stickyBottom) return
    const el = viewportRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [isActive, stickyBottom, visibleLines])

  const onScroll = () => {
    const el = viewportRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 16
    setStickyBottom(nearBottom)
  }

  const jumpToBottom = () => {
    const el = viewportRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    setStickyBottom(true)
  }

  return (
    <div
      className="relative flex h-full flex-col"
      style={isActive ? undefined : { display: 'none' }}
    >
      <div className="flex items-center justify-between border-b border-slate-700 px-2.5 py-2">
        <span className="font-mono text-[11px] text-slate-400">
          task {taskId.slice(0, 8)} • {status}
        </span>
        <button
          type="button"
          className="rounded border border-slate-500 bg-transparent px-2 py-1 text-[11px] text-slate-200"
          onClick={onClear}
        >
          Clear
        </button>
      </div>
      <div
        className="flex-1 overflow-auto bg-[#0f1320] p-2.5 font-mono text-sm text-gray-200"
        ref={viewportRef}
        onScroll={onScroll}
      >
        {visibleLines.length === 0 ? (
          <div className="italic text-slate-500">No output yet.</div>
        ) : showTimestamps ? (
          visibleLines.map((line, idx) => (
            <div
              key={`${taskId}-${idx}-${line.raw.length}`}
              className={`break-words whitespace-pre-wrap ${line.stream === 'stderr' ? 'text-rose-300' : ''}`}
            >
              {line.ts ? (
                <span className="text-slate-500">
                  {new Date(line.ts).toLocaleTimeString()}{' '}
                </span>
              ) : null}
              {line.raw}
            </div>
          ))
        ) : (
          blocks.map((block, idx) => (
            <div key={`${taskId}-block-${idx}`} className="mb-2 last:mb-0">
              <LogBlockRenderer block={block} />
            </div>
          ))
        )}
      </div>
      {!stickyBottom && (
        <button
          type="button"
          className="absolute bottom-3 right-3 rounded-md border border-slate-600 bg-slate-800 px-2.5 py-1.5 text-xs text-slate-200"
          onClick={jumpToBottom}
        >
          Jump to bottom
        </button>
      )}
    </div>
  )
}
