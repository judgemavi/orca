import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef, useState } from 'react'
import { useTerminalSession } from './useTerminalSession'

interface Props {
  sessionId: string
  className?: string
}

export function TerminalPane({ sessionId, className }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const [terminal, setTerminal] = useState<Terminal | null>(null)

  useEffect(() => {
    if (!containerRef.current) return

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: '#0f1320',
        foreground: '#e2e8f0',
        cursor: '#e2e8f0',
        selectionBackground: '#334155',
      },
      allowProposedApi: true,
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(new WebLinksAddon())
    term.open(containerRef.current)
    fitAddon.fit()

    terminalRef.current = term
    fitAddonRef.current = fitAddon
    setTerminal(term)

    return () => {
      term.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
      setTerminal(null)
    }
  }, [])

  const { sendResize } = useTerminalSession({
    sessionId,
    terminal,
  })

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const observer = new ResizeObserver(() => {
      const fitAddon = fitAddonRef.current
      const currentTerminal = terminalRef.current
      if (fitAddon && currentTerminal) {
        fitAddon.fit()
        sendResize(currentTerminal.cols, currentTerminal.rows)
      }
    })

    observer.observe(container)
    return () => observer.disconnect()
  }, [sendResize])

  return (
    <div ref={containerRef} className={`h-full w-full ${className ?? ''}`} />
  )
}
