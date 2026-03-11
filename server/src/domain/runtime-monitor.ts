export interface MonitorContext {
  signal?: AbortSignal;
}

export interface RuntimeMonitor {
  start(ctx?: MonitorContext): void;
  stop(): void;
}

interface PollingMonitorOptions {
  intervalMS?: number;
  onStop?: () => void;
  tick: () => Promise<void>;
}

export class PollingMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private tickInFlight = false;
  private abortListener: (() => void) | null = null;

  constructor(private readonly options: PollingMonitorOptions) {}

  start(ctx: MonitorContext = {}): void {
    if (this.timer) return;

    const interval = Math.max(1_000, this.options.intervalMS ?? 1_000);
    this.timer = setInterval(() => {
      void this.runTick();
    }, interval);

    if (ctx.signal) {
      const onAbort = () => this.stop();
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      this.abortListener = () =>
        ctx.signal?.removeEventListener('abort', onAbort);
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.abortListener) {
      this.abortListener();
      this.abortListener = null;
    }
    this.options.onStop?.();
  }

  private async runTick(): Promise<void> {
    if (this.tickInFlight) return;
    this.tickInFlight = true;
    try {
      await this.options.tick();
    } finally {
      this.tickInFlight = false;
    }
  }
}

export function dedupeNormalizedStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}
