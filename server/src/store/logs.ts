import type { LogEntry, LogQueryFilter } from './types';

const DEFAULT_MAX_SIZE = 50 * 1024 * 1024;

export class RotatingLogWriter {
  constructor(
    private readonly path: string,
    private readonly maxSizeBytes = DEFAULT_MAX_SIZE,
  ) {}

  async writeLine(jsonLine: string): Promise<void> {
    await this.rotateIfNeeded(jsonLine.length + 1);
    const prior = await Bun.file(this.path)
      .text()
      .catch(() => '');
    const line = jsonLine.endsWith('\n') ? jsonLine : `${jsonLine}\n`;
    await Bun.write(this.path, prior + line);
  }

  private async rotateIfNeeded(incomingBytes: number): Promise<void> {
    const file = Bun.file(this.path);
    const exists = await file.exists();
    if (!exists) {
      await ensureDir(this.path);
      return;
    }

    if (file.size + incomingBytes <= this.maxSizeBytes) {
      return;
    }

    const rotated = `${this.path}.1`;
    await Bun.$`rm -f ${rotated}`;
    await Bun.$`mv ${this.path} ${rotated}`;
  }
}

export class LogStore {
  async query(
    logPath: string,
    filter: LogQueryFilter = {},
  ): Promise<LogEntry[]> {
    const path = logPath.trim();
    if (!path) throw new Error('log path required');

    const raw = await Bun.file(path).text();
    const lines = raw.split('\n');

    const normalizedLevel = (filter.level ?? '').trim().toLowerCase();
    const taskID = (filter.taskId ?? '').trim();
    const pattern = (filter.pattern ?? '').trim().toLowerCase();

    const out: LogEntry[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const entry = parseEntry(trimmed);
      if (!entry) continue;

      if (normalizedLevel && entry.level.toLowerCase() !== normalizedLevel)
        continue;
      if (taskID) {
        const attrTaskID = String(entry.attrs?.taskId ?? '');
        if (attrTaskID !== taskID) continue;
      }
      if (filter.since && entry.time < filter.since) continue;

      if (pattern) {
        const body = trimmed.toLowerCase();
        if (
          !entry.msg.toLowerCase().includes(pattern) &&
          !body.includes(pattern)
        )
          continue;
      }

      out.push(entry);
      if (filter.limit && filter.limit > 0 && out.length >= filter.limit) break;
    }

    return out;
  }
}

function parseEntry(raw: string): LogEntry | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }

  const timeRaw = String(parsed.time ?? '');
  const date = new Date(timeRaw);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const attrs: Record<string, unknown> = { ...parsed };
  delete attrs.time;
  delete attrs.level;
  delete attrs.msg;

  return {
    time: date,
    level: String(parsed.level ?? ''),
    msg: String(parsed.msg ?? ''),
    attrs: Object.keys(attrs).length > 0 ? attrs : undefined,
  };
}

async function ensureDir(path: string): Promise<void> {
  const slash = path.lastIndexOf('/');
  if (slash <= 0) return;
  const dir = path.slice(0, slash);
  await Bun.$`mkdir -p ${dir}`;
}
