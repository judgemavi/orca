import * as Tabs from '@radix-ui/react-tabs'
import { useEffect, useMemo, useState } from 'react'
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

function splitDiffByFile(raw: string): Record<string, string> {
  const sections: Array<{ file: string; lines: string[] }> = []
  let currentFile = ''
  let currentLines: string[] = []

  const pushSection = () => {
    if (currentLines.length === 0) return
    sections.push({ file: currentFile, lines: currentLines })
  }

  for (const line of raw.replace(/\r\n/g, '\n').split('\n')) {
    if (line.startsWith('diff --git ')) {
      pushSection()
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/)
      currentFile = match?.[2] ?? ''
      currentLines = [line]
      continue
    }
    if (currentLines.length > 0) {
      currentLines.push(line)
    }
  }

  pushSection()
  return sections.reduce<Record<string, string>>((acc, section) => {
    if (section.file) acc[section.file] = section.lines.join('\n')
    return acc
  }, {})
}

export function DiffViewer({ data, onAction }: Props) {
  const filesChanged = data?.files_changed ?? []
  const actions = data?.actions ?? []
  const diffByFile = useMemo(
    () => splitDiffByFile(data?.diff ?? ''),
    [data?.diff],
  )
  const [activeFile, setActiveFile] = useState(filesChanged[0] ?? '')

  useEffect(() => {
    setActiveFile(filesChanged[0] ?? '')
  }, [data?.task_id, data?.diff])

  const selectedDiff = activeFile
    ? (diffByFile[activeFile] ?? data?.diff ?? '')
    : (data?.diff ?? '')
  const { oldValue, newValue } = useMemo(
    () => parseDiff(selectedDiff),
    [selectedDiff],
  )

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-slate-700 bg-slate-900 p-4">
      <div className="text-sm font-semibold">{data?.title}</div>
      <Tabs.Root value={activeFile} onValueChange={setActiveFile}>
        {filesChanged.length > 1 && (
          <Tabs.List className="flex gap-1 border-b border-slate-700 pb-2">
            {filesChanged.map((f) => (
              <Tabs.Trigger
                key={f}
                value={f}
                className="rounded px-2.5 py-1 font-mono text-xs data-[state=active]:bg-slate-800 data-[state=active]:font-semibold data-[state=active]:text-slate-100 data-[state=inactive]:text-slate-400 data-[state=inactive]:hover:bg-slate-800"
              >
                {f.split('/').pop()}
              </Tabs.Trigger>
            ))}
          </Tabs.List>
        )}
        {filesChanged.map((f) => (
          <Tabs.Content
            key={f}
            value={f}
            forceMount={filesChanged.length <= 1 ? true : undefined}
          >
            <div className="overflow-hidden rounded-md border border-slate-700">
              <ReactDiffViewer
                oldValue={oldValue}
                newValue={newValue}
                splitView={false}
                compareMethod={DiffMethod.LINES}
                useDarkTheme={false}
                styles={{
                  contentText: {
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                    fontSize: '12px',
                  },
                }}
              />
            </div>
          </Tabs.Content>
        ))}
        {filesChanged.length === 0 && (
          <div className="overflow-hidden rounded-md border border-slate-700">
            <ReactDiffViewer
              oldValue={oldValue}
              newValue={newValue}
              splitView={false}
              compareMethod={DiffMethod.LINES}
              useDarkTheme={false}
              styles={{
                contentText: {
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                  fontSize: '12px',
                },
              }}
            />
          </div>
        )}
      </Tabs.Root>
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
