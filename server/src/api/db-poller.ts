import { sql } from 'drizzle-orm';
import type { OrcaDrizzleDB } from '../db/connection';
import { log } from '../shared/logger';
import type { EventSink } from './ws';

interface ChangelogRow {
  id: number;
  table_name: string;
  row_id: string;
  action: string;
  created_at: string;
}

export class DbChangePoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastId = 0;

  constructor(
    private readonly db: OrcaDrizzleDB,
    private readonly sink: EventSink,
    private readonly intervalMs = 2000,
  ) {}

  start() {
    if (this.timer) return;
    // Clear stale entries — on server start we're already in sync
    this.db.run(sql`DELETE FROM _changelog`);
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    log.info('db-poller started', { intervalMs: this.intervalMs });
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    log.info('db-poller stopped');
  }

  private tick() {
    try {
      const rows = this.db.all<ChangelogRow>(
        sql`SELECT id, table_name, row_id, action, created_at FROM _changelog WHERE id > ${this.lastId} ORDER BY id LIMIT 500`,
      );
      if (rows.length === 0) return;

      const maxId = rows[rows.length - 1]!.id;
      this.lastId = maxId;

      // Clean consumed entries
      this.db.run(sql`DELETE FROM _changelog WHERE id <= ${maxId}`);

      // Group by table+action for efficient broadcasting
      const creates = new Map<string, string[]>();
      const updates = new Map<string, string[]>();
      const deletes = new Map<string, string[]>();

      for (const row of rows) {
        const map =
          row.action === 'insert'
            ? creates
            : row.action === 'delete'
              ? deletes
              : updates;
        const list = map.get(row.table_name);
        if (list) list.push(row.row_id);
        else map.set(row.table_name, [row.row_id]);
      }

      // Broadcast per table
      for (const [table, ids] of creates) {
        this.sink.broadcast('db.insert', { table, ids: dedupe(ids) });
      }
      for (const [table, ids] of updates) {
        this.sink.broadcast('db.update', { table, ids: dedupe(ids) });
      }
      for (const [table, ids] of deletes) {
        this.sink.broadcast('db.delete', { table, ids: dedupe(ids) });
      }
    } catch (err) {
      log.error('db-poller tick error', { error: String(err) });
    }
  }
}

function dedupe(arr: string[]): string[] {
  return [...new Set(arr)];
}
