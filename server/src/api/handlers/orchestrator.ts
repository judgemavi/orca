import type { Hono } from 'hono';
import type { DriverRegistry } from '../../driver/registry';
import {
  ORCHESTRATOR_ALLOWED_TOOLS,
  buildMCPServerDef,
  loadOrchestratorPrompt,
  resolveSupervisor,
} from '../../orchestrator/bootstrap';
import type { ConfigStore } from '../../store/config';
import type { EventSink } from '../ws';

const SCROLLBACK_LIMIT = 100_000;

interface OrchestratorPTY {
  proc: ReturnType<typeof Bun.spawn>;
  scrollback: Buffer[];
  scrollbackBytes: number;
  ws: any | null;
  dead: boolean;
}

let activePTY: OrchestratorPTY | null = null;

export function killActivePTY(): boolean {
  if (!activePTY || activePTY.dead) return false;
  console.log('[orchestrator] killing active PTY pid:', activePTY.proc.pid);
  try { activePTY.proc.kill(); } catch {}
  try { activePTY.proc.terminal?.close(); } catch {}
  try { activePTY.ws?.close(); } catch {}
  activePTY.dead = true;
  activePTY = null;
  return true;
}

export function registerOrchestratorHandlers(
  app: Hono,
  _sink: EventSink,
  configStore: ConfigStore,
  repoDir: string,
  registry: DriverRegistry,
) {
  app.get('/orchestrator', (c) =>
    c.json({ error: 'websocket upgrade required' }, 426),
  );

  app.get('/orchestrator/status', (c) =>
    c.json({
      data: {
        active: activePTY !== null && !activePTY.dead,
        sessionId: activePTY ? String(activePTY.proc.pid) : null,
      },
    }),
  );
}

export function handleOrchestratorUpgrade(
  request: Request,
  serverRef: { upgrade: (req: Request, opts?: any) => boolean },
  configStore: ConfigStore,
  repoDir: string,
  registry: DriverRegistry,
): boolean {
  const url = new URL(request.url);
  if (url.pathname !== '/api/v1/orchestrator') return false;

  const cols = parseInt(url.searchParams.get('cols') || '80', 10);
  const rows = parseInt(url.searchParams.get('rows') || '24', 10);

  return serverRef.upgrade(request, {
    data: { configStore, repoDir, registry, cols, rows },
  });
}

export async function onOrchestratorWSOpen(ws: any) {
  const { configStore, repoDir, registry, cols, rows } = ws.data;

  // Reattach to existing PTY if alive
  if (activePTY && !activePTY.dead) {
    console.log('[orchestrator] reattaching to pid:', activePTY.proc.pid);
    activePTY.ws = ws;
    ws.data.reattached = true;

    // Replay scrollback so the client sees prior output
    for (const chunk of activePTY.scrollback) {
      try {
        ws.sendBinary(chunk);
      } catch {}
    }

    // Force redraw: resize triggers SIGWINCH which makes TUIs repaint.
    // Nudge to a different size first to guarantee the change is detected.
    try {
      activePTY.proc.terminal?.resize(cols + 1, rows);
      activePTY.proc.terminal?.resize(cols, rows);
    } catch {}
    return;
  }

  try {
    const resolved = await resolveSupervisor(configStore, registry);
    const systemPrompt = await loadOrchestratorPrompt(repoDir);
    const mcpServer = buildMCPServerDef(repoDir);

    const args = await resolved.driver.interactiveArgs({
      model: resolved.model,
      systemPrompt,
      allowedTools: ORCHESTRATOR_ALLOWED_TOOLS,
      mcpServers: { orca: mcpServer },
      repoDir,
    });

    const cmd = [resolved.driver.binary(), ...args];
    console.log('[orchestrator] spawning:', cmd.join(' '));
    console.log('[orchestrator] cwd:', repoDir);
    console.log('[orchestrator] terminal:', cols, 'x', rows);

    const filteredEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (key === 'CLAUDECODE') continue;
      if (value === undefined) continue;
      filteredEnv[key] = value;
    }

    const pty: OrchestratorPTY = {
      proc: null as any,
      scrollback: [],
      scrollbackBytes: 0,
      ws,
      dead: false,
    };

    const proc = Bun.spawn({
      cmd,
      cwd: repoDir,
      env: filteredEnv,
      terminal: {
        cols,
        rows,
        data(_terminal: any, data: Uint8Array) {
          const buf = Buffer.from(data);

          // Buffer scrollback for reattach
          pty.scrollback.push(buf);
          pty.scrollbackBytes += buf.length;
          while (pty.scrollbackBytes > SCROLLBACK_LIMIT && pty.scrollback.length > 1) {
            pty.scrollbackBytes -= pty.scrollback[0]!.length;
            pty.scrollback.shift();
          }

          // Forward to connected client
          if (pty.ws) {
            try {
              pty.ws.sendBinary(buf);
            } catch {}
          }
        },
        exit(_terminal: any, exitCode: number, signal: string | null) {
          console.log(
            '[orchestrator] PTY exited, code:',
            exitCode,
            'signal:',
            signal,
          );
        },
      },
    });

    pty.proc = proc;
    activePTY = pty;
    console.log('[orchestrator] spawned pid:', proc.pid);

    proc.exited.then((code) => {
      console.log('[orchestrator] process exited, code:', code);
      pty.dead = true;
      if (activePTY === pty) activePTY = null;
      try {
        pty.ws?.close();
      } catch {}
    });
  } catch (err) {
    console.error('[orchestrator] spawn error:', err);
    const msg =
      err instanceof Error ? err.message : 'Failed to spawn orchestrator';
    try {
      ws.send(new TextEncoder().encode(`\r\nError: ${msg}\r\n`));
      ws.close();
    } catch {}
  }
}

export function onOrchestratorWSMessage(ws: any, message: any) {
  if (!activePTY || activePTY.dead) return;
  const proc = activePTY.proc;

  if (typeof message === 'string') {
    try {
      const parsed = JSON.parse(message);
      if (parsed.type === 'resize' && parsed.cols && parsed.rows) {
        proc.terminal?.resize(parsed.cols, parsed.rows);
        return;
      }
    } catch {}
    proc.terminal?.write(new TextEncoder().encode(message));
  } else {
    proc.terminal?.write(message);
  }
}

export function onOrchestratorWSClose(_ws: any) {
  // Detach client but keep PTY alive
  if (activePTY) {
    activePTY.ws = null;
    console.log('[orchestrator] client detached, PTY still alive pid:', activePTY.proc.pid);
  }
}
