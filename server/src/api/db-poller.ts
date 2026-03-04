import { sql } from 'drizzle-orm';
import type { OrcaDrizzleDB } from '../db/connection';
import type { ConfigStore } from '../store/config';
import type { EventSink } from './ws';

interface Fingerprints {
  tasks: string;
  interactions: string;
  reviews: string;
  memory: string;
  jobs: string;
  config: string;
}

const FINGERPRINT_QUERY = sql`
  SELECT
    (SELECT count(*)||':'||coalesce(max(rowid),0)||':'||coalesce(max(updated_at),'') FROM tasks) as tasks_fp,
    (SELECT count(*)||':'||coalesce(max(rowid),0) FROM task_interactions) as interactions_fp,
    (SELECT count(*)||':'||coalesce(max(rowid),0) FROM task_reviews) as reviews_fp,
    (SELECT count(*)||':'||coalesce(max(rowid),0)||':'||coalesce(max(updated_at),'') FROM memory_entries) as memory_fp,
    (SELECT count(*)||':'||coalesce(max(rowid),0) FROM jobs) as jobs_fp,
    (SELECT count(*)||':'||coalesce(max(rowid),0) FROM config) as config_fp
`;

type FingerprintRow = {
  tasks_fp: string;
  interactions_fp: string;
  reviews_fp: string;
  memory_fp: string;
  jobs_fp: string;
  config_fp: string;
};

function rowToFingerprints(row: FingerprintRow): Fingerprints {
  return {
    tasks: row.tasks_fp,
    interactions: row.interactions_fp,
    reviews: row.reviews_fp,
    memory: row.memory_fp,
    jobs: row.jobs_fp,
    config: row.config_fp,
  };
}

export class DbChangePoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private prev: Fingerprints | null = null;

  constructor(
    private readonly db: OrcaDrizzleDB,
    private readonly sink: EventSink,
    private readonly configStore: ConfigStore,
    private readonly intervalMs = 1500,
  ) {}

  start() {
    if (this.timer) return;
    // Capture initial fingerprints without broadcasting
    this.prev = this.poll();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    console.log(`[db-poller] started (${this.intervalMs}ms interval)`);
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    console.log('[db-poller] stopped');
  }

  private poll(): Fingerprints {
    const rows = this.db.all<FingerprintRow>(FINGERPRINT_QUERY);
    return rowToFingerprints(rows[0]!);
  }

  private tick() {
    try {
      const current = this.poll();
      if (!this.prev) {
        this.prev = current;
        return;
      }
      this.diff(this.prev, current);
      this.prev = current;
    } catch (err) {
      console.error('[db-poller] tick error:', err);
    }
  }

  private diff(prev: Fingerprints, curr: Fingerprints) {
    if (prev.tasks !== curr.tasks) {
      this.sink.broadcast('task.updated', { id: '*' });
    }

    if (prev.interactions !== curr.interactions) {
      this.sink.broadcast('interaction.updated', { id: '*' });
    }

    if (prev.reviews !== curr.reviews) {
      this.sink.broadcast('ai_review.completed', { taskId: '*' });
    }

    if (prev.memory !== curr.memory) {
      this.sink.broadcast('memory.sync', { external: true });
    }

    if (prev.jobs !== curr.jobs) {
      this.sink.broadcast('queue.job.completed', { jobId: '*' });
    }

    if (prev.config !== curr.config) {
      this.broadcastConfig();
    }
  }

  private broadcastConfig() {
    this.configStore
      .load()
      .then((config) => {
        this.sink.broadcast('config.updated', config);
      })
      .catch((err) => {
        console.error('[db-poller] config load error:', err);
      });
  }
}
