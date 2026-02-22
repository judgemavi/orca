import { useCallback, useEffect, useRef } from 'react'
import type { Terminal } from '@xterm/xterm'

interface UseTerminalSessionOpts {
  sessionId: string | null
  terminal: Terminal | null
}

export function useTerminalSession({
  sessionId,
  terminal,
}: UseTerminalSessionOpts) {
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const connect = useCallback(() => {
    if (!sessionId || !terminal) return

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(
      `${protocol}//${window.location.host}/api/v1/terminal/${sessionId}`,
    )
    ws.binaryType = 'arraybuffer'

    ws.onopen = () => {
      const dims = { type: 'resize', cols: terminal.cols, rows: terminal.rows }
      ws.send(JSON.stringify(dims))
    }

    ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) {
        terminal.write(new Uint8Array(e.data))
      }
    }

    ws.onclose = () => {
      reconnectRef.current = setTimeout(connect, 2000)
    }

    wsRef.current = ws
  }, [sessionId, terminal])

  useEffect(() => {
    if (!terminal) return

    const disposable = terminal.onData((data: string) => {
      const ws = wsRef.current
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(new TextEncoder().encode(data))
      }
    })

    return () => disposable.dispose()
  }, [terminal])

  useEffect(() => {
    connect()

    return () => {
      if (reconnectRef.current) {
        clearTimeout(reconnectRef.current)
      }
      wsRef.current?.close()
    }
  }, [connect])

  const sendResize = useCallback((cols: number, rows: number) => {
    const ws = wsRef.current
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', cols, rows }))
    }
  }, [])

  return { sendResize }
}
