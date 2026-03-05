import { useEffect, useRef } from 'react';
import 'xterm/css/xterm.css';

const WS_BASE = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}`;

const DARK_THEME = {
  background: '#1a1a2e',
  foreground: '#e0e0e0',
  cursor: '#e0e0e0',
  selectionBackground: '#3a3a5e',
};

const LIGHT_THEME = {
  background: '#ffffff',
  foreground: '#1a1a2e',
  cursor: '#1a1a2e',
  selectionBackground: '#d0d0e0',
};

interface Props {
  className?: string;
  theme: 'light' | 'dark';
}

export function TerminalPane({ className, theme }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<any>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let cancelled = false;
    let ws: WebSocket | null = null;
    let fitAddon: any = null;
    let resizeObserver: ResizeObserver | null = null;

    async function init() {
      const [{ Terminal }, { FitAddon }, { WebLinksAddon }, { WebglAddon }] =
        await Promise.all([
          import('xterm'),
          import('@xterm/addon-fit'),
          import('@xterm/addon-web-links'),
          import('@xterm/addon-webgl'),
        ]);

      if (cancelled) return;

      const terminal = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily:
          'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
        scrollback: 2000,
        convertEol: true,
        theme: theme === 'dark' ? DARK_THEME : LIGHT_THEME,
      });

      terminalRef.current = terminal;

      fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.loadAddon(new WebLinksAddon());

      terminal.open(el);

      try {
        terminal.loadAddon(new WebglAddon());
      } catch {}

      fitAddon.fit();

      const cols = terminal.cols;
      const rows = terminal.rows;

      ws = new WebSocket(
        `${WS_BASE}/api/v1/orchestrator?cols=${cols}&rows=${rows}`,
      );
      ws.binaryType = 'arraybuffer';

      // Write batching — coalesce WS messages, flush once per frame
      let writeBuf: Uint8Array[] = [];
      let rafId: number | null = null;

      function flushWrites() {
        rafId = null;
        if (!terminal || writeBuf.length === 0) return;
        const total = writeBuf.reduce((s, b) => s + b.length, 0);
        const merged = new Uint8Array(total);
        let offset = 0;
        for (const chunk of writeBuf) {
          merged.set(chunk, offset);
          offset += chunk.length;
        }
        writeBuf = [];
        terminal.write(merged);
      }

      function queueWrite(data: Uint8Array) {
        writeBuf.push(data);
        if (rafId === null) {
          rafId = requestAnimationFrame(flushWrites);
        }
      }

      ws.onopen = () => {
        terminal.focus();
      };

      ws.onmessage = (event: MessageEvent) => {
        if (event.data instanceof ArrayBuffer) {
          queueWrite(new Uint8Array(event.data));
        } else {
          queueWrite(new TextEncoder().encode(event.data));
        }
      };

      ws.onclose = () => {
        terminal.write('\r\n\x1b[90m[session ended]\x1b[0m\r\n');
      };

      ws.onerror = () => {
        terminal.write('\r\n\x1b[31m[connection error]\x1b[0m\r\n');
      };

      terminal.onData((data: string) => {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(data);
        }
      });

      terminal.onBinary((data: string) => {
        if (ws?.readyState === WebSocket.OPEN) {
          const buf = new Uint8Array(data.length);
          for (let i = 0; i < data.length; i++) {
            buf[i] = data.charCodeAt(i);
          }
          ws.send(buf);
        }
      });

      resizeObserver = new ResizeObserver(() => {
        if (!fitAddon || !terminal) return;
        try {
          fitAddon.fit();
          if (ws?.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: 'resize',
                cols: terminal.cols,
                rows: terminal.rows,
              }),
            );
          }
        } catch {}
      });
      resizeObserver.observe(el!);

      cleanupRef.current = () => {
        cancelled = true;
        if (rafId !== null) cancelAnimationFrame(rafId);
        resizeObserver?.disconnect();
        if (ws) {
          ws.onclose = null;
          ws.close();
        }
        terminal?.dispose();
        terminalRef.current = null;
      };
    }

    init();

    return () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, []);

  // Sync theme changes to live terminal
  useEffect(() => {
    const t = terminalRef.current;
    if (!t) return;
    t.options.theme = theme === 'dark' ? DARK_THEME : LIGHT_THEME;
  }, [theme]);

  return (
    <div
      ref={containerRef}
      className={`h-full w-full overflow-hidden ${className ?? ''}`}
    />
  );
}
