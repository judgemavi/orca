import { and, asc, count, eq, lt, or, sql } from 'drizzle-orm';
import type { EventSink } from '../api/ws';
import type { OrcaDrizzleDB } from '../db/connection';
import { jobs as jobsTable } from '../db/schema';
import type {
  Job,
  JobStatus as JobStatusType,
  JobType as JobTypeType,
} from '../types';
import { JOB_PRIORITIES, JobStatus } from '../types';

type JobRow = typeof jobsTable.$inferSelect;

type OnEnqueueCallback = (job: Job) => void;

function ensureUTC(ts: string | null): string | null {
  if (!ts) return null;
  if (ts.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(ts)) return ts;
  return `${ts}Z`;
}

function mapJob(row: JobRow): Job {
  return {
    id: row.id,
    type: row.type as JobTypeType,
    taskId: row.taskId,
    status: row.status as JobStatusType,
    priority: row.priority,
    payload: row.payload
      ? (JSON.parse(row.payload) as Record<string, unknown>)
      : null,
    error: row.error,
    result: row.result
      ? (JSON.parse(row.result) as Record<string, unknown>)
      : null,
    createdAt: ensureUTC(row.createdAt) ?? row.createdAt,
    startedAt: ensureUTC(row.startedAt),
    completedAt: ensureUTC(row.completedAt),
  };
}

export class JobQueue {
  private onEnqueueCallback?: OnEnqueueCallback;

  constructor(
    private readonly db: OrcaDrizzleDB,
    private readonly sink?: EventSink,
  ) {}

  setOnEnqueue(cb: OnEnqueueCallback): void {
    this.onEnqueueCallback = cb;
  }

  async enqueue(opts: {
    type: JobTypeType;
    taskId?: string;
    priority?: number;
    payload?: Record<string, unknown>;
  }): Promise<Job> {
    const id = crypto.randomUUID();
    const priority = opts.priority ?? JOB_PRIORITIES[opts.type] ?? 5;

    await this.db.insert(jobsTable).values({
      id,
      type: opts.type,
      taskId: opts.taskId ?? null,
      status: JobStatus.queued,
      priority,
      payload: opts.payload ? JSON.stringify(opts.payload) : null,
      createdAt: sql`(CURRENT_TIMESTAMP)`,
    });

    const job = await this.get(id);
    if (!job) throw new Error(`failed to create job: ${id}`);

    this.sink?.broadcast('queue.job.queued', {
      jobId: job.id,
      type: job.type,
      ...(job.taskId ? { taskId: job.taskId } : {}),
      priority: job.priority,
    });

    this.onEnqueueCallback?.(job);
    return job;
  }

  async claim(maxParallel: number): Promise<Job[]> {
    return this.db.transaction(async (tx) => {
      // BEGIN IMMEDIATE via drizzle transaction
      const runningRows = await tx
        .select({ count: count() })
        .from(jobsTable)
        .where(eq(jobsTable.status, JobStatus.running));
      const runningCount = runningRows[0]?.count ?? 0;
      const available = maxParallel - runningCount;
      if (available <= 0) return [];

      const candidates = await tx
        .select()
        .from(jobsTable)
        .where(eq(jobsTable.status, JobStatus.queued))
        .orderBy(asc(jobsTable.priority), asc(jobsTable.createdAt))
        .limit(available);

      if (candidates.length === 0) return [];

      const ids = candidates.map((r) => r.id);
      const now = new Date().toISOString();

      const updated: Job[] = [];
      for (const jobId of ids) {
        await tx
          .update(jobsTable)
          .set({ status: JobStatus.running, startedAt: now })
          .where(
            and(
              eq(jobsTable.id, jobId),
              eq(jobsTable.status, JobStatus.queued),
            ),
          );
        const rows = await tx
          .select()
          .from(jobsTable)
          .where(eq(jobsTable.id, jobId))
          .limit(1);
        if (rows[0] && rows[0].status === JobStatus.running) {
          updated.push(mapJob(rows[0]));
        }
      }

      for (const job of updated) {
        this.sink?.broadcast('queue.job.started', {
          jobId: job.id,
          type: job.type,
          ...(job.taskId ? { taskId: job.taskId } : {}),
        });
      }

      return updated;
    });
  }

  async complete(
    jobId: string,
    result?: Record<string, unknown>,
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .update(jobsTable)
      .set({
        status: JobStatus.completed,
        completedAt: now,
        result: result ? JSON.stringify(result) : null,
      })
      .where(eq(jobsTable.id, jobId));

    const job = await this.get(jobId);
    if (job) {
      this.sink?.broadcast('queue.job.completed', {
        jobId: job.id,
        type: job.type,
        ...(job.taskId ? { taskId: job.taskId } : {}),
      });
    }
  }

  async fail(jobId: string, error: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .update(jobsTable)
      .set({
        status: JobStatus.failed,
        completedAt: now,
        error,
      })
      .where(eq(jobsTable.id, jobId));

    const job = await this.get(jobId);
    if (job) {
      this.sink?.broadcast('queue.job.failed', {
        jobId: job.id,
        type: job.type,
        ...(job.taskId ? { taskId: job.taskId } : {}),
        error,
      });
    }
  }

  async cancel(jobId: string): Promise<boolean> {
    const result = await this.db
      .update(jobsTable)
      .set({ status: JobStatus.cancelled })
      .where(
        and(eq(jobsTable.id, jobId), eq(jobsTable.status, JobStatus.queued)),
      )
      .returning({ id: jobsTable.id });

    if (result.length === 0) return false;

    const job = await this.get(jobId);
    if (job) {
      this.sink?.broadcast('queue.job.cancelled', {
        jobId: job.id,
        type: job.type,
        ...(job.taskId ? { taskId: job.taskId } : {}),
      });
    }
    return true;
  }

  async cancelForTask(taskId: string): Promise<number> {
    const result = await this.db
      .update(jobsTable)
      .set({ status: JobStatus.cancelled })
      .where(
        and(
          eq(jobsTable.taskId, taskId),
          eq(jobsTable.status, JobStatus.queued),
        ),
      )
      .returning({ id: jobsTable.id, type: jobsTable.type });

    for (const row of result) {
      this.sink?.broadcast('queue.job.cancelled', {
        jobId: row.id,
        type: row.type,
        taskId,
      });
    }

    return result.length;
  }

  async get(jobId: string): Promise<Job | null> {
    const rows = await this.db
      .select()
      .from(jobsTable)
      .where(eq(jobsTable.id, jobId))
      .limit(1);
    return rows[0] ? mapJob(rows[0]) : null;
  }

  async list(filter?: {
    status?: JobStatusType;
    taskId?: string;
    limit?: number;
  }): Promise<Job[]> {
    const conditions = [];
    if (filter?.status) conditions.push(eq(jobsTable.status, filter.status));
    if (filter?.taskId) conditions.push(eq(jobsTable.taskId, filter.taskId));

    const query = this.db
      .select()
      .from(jobsTable)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(jobsTable.priority), asc(jobsTable.createdAt))
      .limit(filter?.limit ?? 500);

    const rows = await query;
    return rows.map(mapJob);
  }

  async counts(): Promise<Record<string, number>> {
    const rows = await this.db
      .select({ status: jobsTable.status, count: count() })
      .from(jobsTable)
      .groupBy(jobsTable.status);

    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.status] = row.count;
    }
    return result;
  }

  async drain(): Promise<number> {
    const result = await this.db
      .update(jobsTable)
      .set({ status: JobStatus.cancelled })
      .where(eq(jobsTable.status, JobStatus.queued))
      .returning({ id: jobsTable.id });
    return result.length;
  }

  async requeueRunning(): Promise<number> {
    const result = await this.db
      .update(jobsTable)
      .set({ status: JobStatus.queued, startedAt: null })
      .where(eq(jobsTable.status, JobStatus.running))
      .returning({ id: jobsTable.id });
    return result.length;
  }

  async pruneOld(maxAge: number, maxKeep: number): Promise<number> {
    const cutoff = new Date(Date.now() - maxAge).toISOString();

    const terminal = or(
      eq(jobsTable.status, JobStatus.completed),
      eq(jobsTable.status, JobStatus.failed),
      eq(jobsTable.status, JobStatus.cancelled),
    );

    // Keep most recent maxKeep completed/failed/cancelled; delete older ones past cutoff
    const toDelete = await this.db
      .select({ id: jobsTable.id })
      .from(jobsTable)
      .where(and(terminal, lt(jobsTable.completedAt, cutoff)))
      .orderBy(asc(jobsTable.completedAt));

    if (toDelete.length === 0) return 0;

    // Determine how many total terminal jobs exist to respect maxKeep
    const totalRows = await this.db
      .select({ count: count() })
      .from(jobsTable)
      .where(terminal);
    const total = totalRows[0]?.count ?? 0;
    const deleteCount = Math.max(0, total - maxKeep);
    if (deleteCount === 0) return 0;

    const idsToDelete = toDelete.slice(0, deleteCount).map((r) => r.id);
    if (idsToDelete.length === 0) return 0;

    let deleted = 0;
    for (const id of idsToDelete) {
      const r = await this.db
        .delete(jobsTable)
        .where(eq(jobsTable.id, id))
        .returning({ id: jobsTable.id });
      deleted += r.length;
    }
    return deleted;
  }
}
