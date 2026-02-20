import { useState } from 'react'
import ReactDiffViewer, { DiffMethod } from 'react-diff-viewer-continued'
import { ActionButton } from '../common/ActionButton'

interface Props {
  data: {
    task_id: string
    title: string
    diff: string
    files_changed: string[]
    actions: string[]
  }
  onAction?: (action: string) => void
}

function parseDiff(raw: string): { oldValue: string; newValue: string } {
  const oldLines: string[] = []
  const newLines: string[] = []
  for (const line of raw.split('\n')) {
    if (
      line.startsWith('---') ||
      line.startsWith('+++') ||
      line.startsWith('@@')
    )
      continue
    if (line.startsWith('-')) {
      oldLines.push(line.slice(1))
    } else if (line.startsWith('+')) {
      newLines.push(line.slice(1))
    } else {
      const content = line.startsWith(' ') ? line.slice(1) : line
      oldLines.push(content)
      newLines.push(content)
    }
  }
  return { oldValue: oldLines.join('\n'), newValue: newLines.join('\n') }
}

export function DiffViewer({ data, onAction }: Props) {
  const [activeFile, setActiveFile] = useState(0)
  const { oldValue, newValue } = parseDiff(data?.diff ?? '')
  const filesChanged = data?.files_changed ?? []
  const actions = data?.actions ?? []

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-slate-700 bg-slate-900 p-4">
      <div className="text-sm font-semibold">{data?.title}</div>
      {filesChanged.length > 1 && (
        <div className="flex gap-1 border-b border-slate-700 pb-2">
          {filesChanged.map((f, i) => (
            <button
              key={f}
              className={`rounded px-2.5 py-1 font-mono text-xs ${i === activeFile ? 'bg-slate-800 font-semibold text-slate-100' : 'text-slate-400 hover:bg-slate-800'}`}
              onClick={() => setActiveFile(i)}
              type="button"
            >
              {f.split('/').pop()}
            </button>
          ))}
        </div>
      )}
      <div className="overflow-hidden rounded-md border border-slate-700">
        <ReactDiffViewer
          oldValue={oldValue}
          newValue={newValue}
          splitView={false}
          compareMethod={DiffMethod.LINES}
          useDarkTheme={false}
          styles={{
            contentText: { fontFamily: 'var(--font-mono)', fontSize: '12px' },
          }}
        />
      </div>
      {actions.length > 0 && (
        <div className="flex justify-end gap-2">
          {actions.map((a) => (
            <ActionButton key={a} label={a} onClick={() => onAction?.(a)} />
          ))}
        </div>
      )}
    </div>
  )
}
