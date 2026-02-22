import { useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism'
import remarkGfm from 'remark-gfm'
import type { LogBlock } from '../../lib/logParser'

interface Props {
  block: LogBlock
}

function CopyButton({ content }: { content: string }) {
  const [copied, setCopied] = useState(false)

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      setCopied(false)
    }
  }

  return (
    <button
      type="button"
      className="rounded border border-slate-600 bg-slate-800 px-2 py-1 text-[11px] text-slate-200"
      onClick={onCopy}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

function JSONBlock({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false)
  const [render, setRender] = useState(false)

  const pretty = useMemo(() => {
    try {
      return JSON.stringify(JSON.parse(content), null, 2)
    } catch {
      return content
    }
  }, [content])

  const firstLine = pretty.split('\n')[0] ?? '{}'

  return (
    <div className="rounded border border-slate-700 bg-slate-950/70">
      <div className="flex items-center justify-between border-b border-slate-700 px-2 py-1.5">
        <button
          type="button"
          className="text-xs text-slate-200"
          onClick={() => {
            const next = !expanded
            setExpanded(next)
            if (next) setRender(true)
          }}
        >
          {expanded ? 'Hide JSON' : 'Show JSON'}
        </button>
        <CopyButton content={pretty} />
      </div>
      {!expanded ? (
        <div className="truncate px-2 py-1.5 text-xs text-slate-300">
          {firstLine}
        </div>
      ) : (
        <div className="text-xs">
          {render ? (
            <SyntaxHighlighter
              language="json"
              style={vscDarkPlus}
              customStyle={{ margin: 0, background: 'transparent' }}
            >
              {pretty}
            </SyntaxHighlighter>
          ) : null}
        </div>
      )}
    </div>
  )
}

export function LogBlockRenderer({ block }: Props) {
  if (block.type === 'stderr') {
    return (
      <div className="break-words whitespace-pre-wrap font-mono text-sm text-rose-300">
        {block.content}
      </div>
    )
  }

  if (block.type === 'json') {
    return <JSONBlock content={block.content} />
  }

  if (block.type === 'markdown') {
    return (
      <div className="prose prose-invert prose-sm max-w-none text-slate-100 prose-p:my-1">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {block.content}
        </ReactMarkdown>
      </div>
    )
  }

  if (block.type === 'code') {
    return (
      <div className="rounded border border-slate-700 bg-slate-950/70">
        <div className="flex items-center justify-between border-b border-slate-700 px-2 py-1.5">
          <span className="text-[11px] text-slate-400">
            {block.language ?? 'code'}
          </span>
          <CopyButton content={block.content} />
        </div>
        <SyntaxHighlighter
          language={block.language}
          style={vscDarkPlus}
          customStyle={{ margin: 0, background: 'transparent' }}
        >
          {block.content}
        </SyntaxHighlighter>
      </div>
    )
  }

  if (block.type === 'diff') {
    return (
      <div className="rounded border border-slate-700 bg-slate-950/70">
        <div className="flex items-center justify-between border-b border-slate-700 px-2 py-1.5">
          <span className="text-[11px] text-slate-400">diff</span>
          <CopyButton content={block.content} />
        </div>
        <SyntaxHighlighter
          language="diff"
          style={vscDarkPlus}
          customStyle={{ margin: 0, background: 'transparent' }}
        >
          {block.content}
        </SyntaxHighlighter>
      </div>
    )
  }

  return (
    <div className="break-words whitespace-pre-wrap font-mono text-sm text-gray-200">
      {block.content}
    </div>
  )
}
