import {
  JOB_STATUSES,
  type JobStatus,
  type JobType,
  SYSTEM_JOB_PRIORITIES,
} from '@orca/types';
import { and, asc, count, eq, lt, ne, or, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { EventSink } from '../api/ws';
import type { OrcaDrizzleDB } from '../db/connection';
import { jobs as jobsTable } from '../db/schema';
import type { Job } from '../types/models';

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
    type: row.type as JobType,
    taskId: row.taskId,
    status: row.status as JobStatus,
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
    type: string;
    taskId?: string;
    priority?: number;
    payload?: Record<string, unknown>;
  }): Promise<Job> {
    const id = nanoid();
    const priority =
      opts.priority ??
      SYSTEM_JOB_PRIORITIES[opts.type as keyof typeof SYSTEM_JOB_PRIORITIES] ??
      5;

    await this.db.insert(jobsTable).values({
      id,
      type: opts.type,
      taskId: opts.taskId ?? null,
      status: JOB_STATUSES.queued,
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

  /**
   * @deprecated Use claimNext instead. Kept for test compatibility.
   */
  async claim(limit: number): Promise<Job[]> {
    return this.claimNext(limit);
  }

  /**
   * Claim up to `limit` queued jobs, marking them as running.
   * Concurrency control is handled by the processor (p-queue), not here.
   */
  async claimNext(limit: number, excludeTypes?: string[]): Promise<Job[]> {
    const updated = this.db.transaction((tx) => {
      const conditions = [eq(jobsTable.status, JOB_STATUSES.queued)];
      if (excludeTypes?.length) {
        for (const t of excludeTypes) {
          conditions.push(ne(jobsTable.type, t));
        }
      }
      const candidates = tx
        .select()
        .from(jobsTable)
        .where(and(...conditions))
        .orderBy(asc(jobsTable.priority), asc(jobsTable.createdAt))
        .limit(limit)
        .all();

      if (candidates.length === 0) return [];

      const now = new Date().toISOString();
      const result: Job[] = [];

      for (const row of candidates) {
        tx.update(jobsTable)
          .set({ status: JOB_STATUSES.running, startedAt: now })
          .where(
            and(
              eq(jobsTable.id, row.id),
              eq(jobsTable.status, JOB_STATUSES.queued),
            ),
          )
          .run();
        const rows = tx
          .select()
          .from(jobsTable)
          .where(eq(jobsTable.id, row.id))
          .limit(1)
          .all();
        if (rows[0] && rows[0].status === JOB_STATUSES.running) {
          result.push(mapJob(rows[0]));
        }
      }

      return result;
    });

    for (const job of updated) {
      this.sink?.broadcast('queue.job.started', {
        jobId: job.id,
        type: job.type,
        ...(job.taskId ? { taskId: job.taskId } : {}),
      });
    }

    return updated;
  }

  async complete(
    jobId: string,
    result?: Record<string, unknown>,
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .update(jobsTable)
      .set({
        status: JOB_STATUSES.completed,
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
        status: JOB_STATUSES.failed,
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
      .set({ status: JOB_STATUSES.cancelled })
      .where(
        and(eq(jobsTable.id, jobId), eq(jobsTable.status, JOB_STATUSES.queued)),
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
      .set({ status: JOB_STATUSES.cancelled })
      .where(
        and(
          eq(jobsTable.taskId, taskId),
          eq(jobsTable.status, JOB_STATUSES.queued),
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
    status?: JobStatus;
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
      .set({ status: JOB_STATUSES.cancelled })
      .where(eq(jobsTable.status, JOB_STATUSES.queued))
      .returning({
        id: jobsTable.id,
        type: jobsTable.type,
        taskId: jobsTable.taskId,
      });

    for (const row of result) {
      this.sink?.broadcast('queue.job.cancelled', {
        jobId: row.id,
        type: row.type,
        ...(row.taskId ? { taskId: row.taskId } : {}),
      });
    }

    return result.length;
  }

  async requeue(jobId: string): Promise<void> {
    await this.db
      .update(jobsTable)
      .set({ status: JOB_STATUSES.queued, startedAt: null })
      .where(
        and(
          eq(jobsTable.id, jobId),
          eq(jobsTable.status, JOB_STATUSES.running),
        ),
      );
  }

  async requeueRunning(): Promise<number> {
    const result = await this.db
      .update(jobsTable)
      .set({ status: JOB_STATUSES.queued, startedAt: null })
      .where(eq(jobsTable.status, JOB_STATUSES.running))
      .returning({ id: jobsTable.id });
    return result.length;
  }

  async pruneOld(maxAge: number, maxKeep: number): Promise<number> {
    const cutoff = new Date(Date.now() - maxAge).toISOString();

    const terminal = or(
      eq(jobsTable.status, JOB_STATUSES.completed),
      eq(jobsTable.status, JOB_STATUSES.failed),
      eq(jobsTable.status, JOB_STATUSES.cancelled),
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
