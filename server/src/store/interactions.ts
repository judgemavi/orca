import { appendFile } from 'node:fs/promises';
import {
  and,
  desc,
  eq,
  gte,
  isNotNull,
  isNull,
  like,
  ne,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import type { EventSink } from '../api/ws';
import type { OrcaDrizzleDB } from '../db/connection';
import { taskInteractions } from '../db/schema';
import { genId } from '../shared/id';
import type { InteractionStatus, InteractionStub } from '../types';
import { INTERACTION_STATUSES } from '../types';
import type { StoredInteraction, ToolSummary } from './types';

type InteractionRow = typeof taskInteractions.$inferSelect;

export interface BeginResult {
  id: string;
  attempt: number;
  logPath: string;
}

export interface RunCostSummary {
  runId: string;
  interactions: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  startedAt: string;
  finishedAt: string;
}

export class InteractionStore {
  constructor(
    private readonly db: OrcaDrizzleDB,
    private readonly baseDir = '.orca/interactions',
    private readonly sink?: EventSink,
  ) {}

  async begin(input: {
    taskId?: string | null;
    type: string;
    tool: string;
  }): Promise<BeginResult> {
    const type = input.type.trim();
    const tool = input.tool.trim();
    if (!type) throw new Error('type required');
    if (!tool) throw new Error('tool required');

    const id = genId();
    const attempt = await this.nextAttempt(input.taskId ?? null, type);
    const logPath = this.logPath(input.taskId ?? null, type, attempt, id);

    await Bun.$`mkdir -p ${this.dirName(logPath)}`;
    await Bun.write(logPath, '');

    await this.db.insert(taskInteractions).values({
      id,
      taskId: input.taskId ?? null,
      type,
      attempt,
      tool,
      logPath,
      status: INTERACTION_STATUSES.running,
      startedAt: sql`(CURRENT_TIMESTAMP)`,
    });

    if (this.sink) {
      const interaction = await this.get(id);
      if (interaction) this.sink.broadcast('interaction.started', interaction);
    }

    return { id, attempt, logPath: logPath };
  }

  async appendRawOutput(interactionID: string, line: string): Promise<void> {
    const rows = await this.db
      .select({ logPath: taskInteractions.logPath })
      .from(taskInteractions)
      .where(eq(taskInteractions.id, interactionID))
      .limit(1);
    const row = rows[0] ?? null;
    if (!row) throw new Error(`interaction ${interactionID} not found`);

    const suffix = line.endsWith('\n') ? line : `${line}\n`;
    await appendFile(row.logPath, suffix);
  }

  async finish(
    id: string,
    fields: {
      status: string;
      error?: string | null;
      diff?: string | null;
      exitCode?: number;
      durationMs?: number;
      qualityJson?: string | null;
      inputTokens?: number;
      outputTokens?: number;
      estimatedCost?: number;
      runId?: string | null;
      model?: string | null;
    },
  ): Promise<void> {
    const updates: {
      status: string;
      finishedAt: SQL;
      error?: string | null;
      diff?: string | null;
      exitCode?: number;
      durationMs?: number;
      qualityJson?: string | null;
      inputTokens?: number;
      outputTokens?: number;
      estimatedCost?: number;
      runId?: string | null;
      model?: string | null;
    } = {
      status: fields.status,
      finishedAt: sql`(CURRENT_TIMESTAMP)`,
    };

    if (fields.error !== undefined) updates.error = fields.error;
    if (fields.diff !== undefined) updates.diff = fields.diff;
    if (fields.exitCode !== undefined) updates.exitCode = fields.exitCode;
    if (fields.durationMs !== undefined) updates.durationMs = fields.durationMs;
    if (fields.qualityJson !== undefined)
      updates.qualityJson = fields.qualityJson;
    if (fields.inputTokens !== undefined)
      updates.inputTokens = fields.inputTokens;
    if (fields.outputTokens !== undefined)
      updates.outputTokens = fields.outputTokens;
    if (fields.estimatedCost !== undefined)
      updates.estimatedCost = fields.estimatedCost;
    if (fields.runId !== undefined) updates.runId = fields.runId;
    if (fields.model !== undefined) updates.model = fields.model;

    const result = await this.db
      .update(taskInteractions)
      .set(updates)
      .where(eq(taskInteractions.id, id))
      .returning({ id: taskInteractions.id });
    if (result.length === 0) {
      throw new Error(`interaction ${id} not found`);
    }

    if (this.sink) {
      const interaction = await this.get(id);
      if (interaction) {
        if (interaction.status === INTERACTION_STATUSES.completed) {
          this.sink.broadcast('interaction.completed', interaction);
        } else if (interaction.status === INTERACTION_STATUSES.failed) {
          this.sink.broadcast('interaction.failed', interaction);
        } else {
          this.sink.broadcast('interaction.updated', interaction);
        }
      }
    }
  }

  async get(id: string): Promise<StoredInteraction | null> {
    const rows = await this.db
      .select()
      .from(taskInteractions)
      .where(eq(taskInteractions.id, id))
      .limit(1);
    const row = rows[0] ?? null;
    return row ? this.mapInteraction(row) : null;
  }

  async list(taskID: string): Promise<StoredInteraction[]> {
    const rows = await this.db
      .select()
      .from(taskInteractions)
      .where(eq(taskInteractions.taskId, taskID))
      .orderBy(desc(taskInteractions.startedAt));
    return rows.map((row) => this.mapInteraction(row));
  }

  async listStubs(taskID: string): Promise<InteractionStub[]> {
    const rows = await this.db
      .select()
      .from(taskInteractions)
      .where(eq(taskInteractions.taskId, taskID))
      .orderBy(desc(taskInteractions.startedAt));
    return rows.map((row) => this.mapStub(row));
  }

  async listByType(taskID: string, type: string): Promise<StoredInteraction[]> {
    const rows = await this.db
      .select()
      .from(taskInteractions)
      .where(
        and(
          eq(taskInteractions.taskId, taskID),
          eq(taskInteractions.type, type),
        ),
      )
      .orderBy(desc(taskInteractions.startedAt));
    return rows.map((row) => this.mapInteraction(row));
  }

  async listByStatus(status: string): Promise<StoredInteraction[]> {
    const rows = await this.db
      .select()
      .from(taskInteractions)
      .where(eq(taskInteractions.status, status))
      .orderBy(desc(taskInteractions.startedAt));
    return rows.map((row) => this.mapInteraction(row));
  }

  async listProjectByType(type: string): Promise<StoredInteraction[]> {
    const rows = await this.db
      .select()
      .from(taskInteractions)
      .where(eq(taskInteractions.type, type))
      .orderBy(desc(taskInteractions.startedAt));
    return rows.map((row) => this.mapInteraction(row));
  }

  async isRunning(taskID: string | null, type: string): Promise<boolean> {
    const normalizedType = type.trim();
    if (!normalizedType) throw new Error('type required');

    const rows = await this.db
      .select({ one: sql<number>`1`.as('one') })
      .from(taskInteractions)
      .where(
        and(
          eq(taskInteractions.type, normalizedType),
          eq(taskInteractions.status, INTERACTION_STATUSES.running),
          taskID?.trim() ? eq(taskInteractions.taskId, taskID) : undefined,
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async readLog(id: string): Promise<string> {
    const rows = await this.db
      .select({ logPath: taskInteractions.logPath })
      .from(taskInteractions)
      .where(eq(taskInteractions.id, id))
      .limit(1);
    const row = rows[0] ?? null;
    if (!row) throw new Error(`interaction ${id} not found`);
    return Bun.file(row.logPath).text();
  }

  async projectTotal(): Promise<number> {
    const rows = await this.db
      .select({
        total: sql<number | null>`sum(${taskInteractions.estimatedCost})`.as(
          'total',
        ),
      })
      .from(taskInteractions);
    return Number(rows[0]?.total ?? 0);
  }

  async runTotal(runID: string): Promise<number> {
    const rows = await this.db
      .select({
        total: sql<number | null>`sum(${taskInteractions.estimatedCost})`.as(
          'total',
        ),
      })
      .from(taskInteractions)
      .where(eq(taskInteractions.runId, runID));
    return Number(rows[0]?.total ?? 0);
  }

  async runSummary(runID: string): Promise<ToolSummary[]> {
    const rows = await this.db
      .select({
        tool: taskInteractions.tool,
        inputTokens: sql<
          number | null
        >`sum(${taskInteractions.inputTokens})`.as('inputTokens'),
        outputTokens: sql<
          number | null
        >`sum(${taskInteractions.outputTokens})`.as('outputTokens'),
        cost: sql<number | null>`sum(${taskInteractions.estimatedCost})`.as(
          'cost',
        ),
      })
      .from(taskInteractions)
      .where(eq(taskInteractions.runId, runID))
      .groupBy(taskInteractions.tool);

    return rows.map((row) => ({
      tool: row.tool,
      inputTokens: Number(row.inputTokens ?? 0),
      outputTokens: Number(row.outputTokens ?? 0),
      cost: Number(row.cost ?? 0),
    }));
  }

  async projectSummary(): Promise<ToolSummary[]> {
    const rows = await this.db
      .select({
        tool: taskInteractions.tool,
        inputTokens: sql<
          number | null
        >`sum(${taskInteractions.inputTokens})`.as('inputTokens'),
        outputTokens: sql<
          number | null
        >`sum(${taskInteractions.outputTokens})`.as('outputTokens'),
        cost: sql<number | null>`sum(${taskInteractions.estimatedCost})`.as(
          'cost',
        ),
      })
      .from(taskInteractions)
      .groupBy(taskInteractions.tool);

    return rows.map((row) => ({
      tool: row.tool,
      inputTokens: Number(row.inputTokens ?? 0),
      outputTokens: Number(row.outputTokens ?? 0),
      cost: Number(row.cost ?? 0),
    }));
  }

  async listRuns(limit = 20): Promise<RunCostSummary[]> {
    const finishedAtExpr = sql<string>`max(coalesce(${taskInteractions.finishedAt}, ${taskInteractions.startedAt}))`;

    const rows = await this.db
      .select({
        runId: taskInteractions.runId,
        interactions: sql<number>`count(*)`.as('interactions'),
        inputTokens: sql<
          number | null
        >`sum(${taskInteractions.inputTokens})`.as('inputTokens'),
        outputTokens: sql<
          number | null
        >`sum(${taskInteractions.outputTokens})`.as('outputTokens'),
        cost: sql<number | null>`sum(${taskInteractions.estimatedCost})`.as(
          'cost',
        ),
        startedAt: sql<string>`min(${taskInteractions.startedAt})`.as(
          'startedAt',
        ),
        finishedAt: finishedAtExpr.as('finishedAt'),
      })
      .from(taskInteractions)
      .where(
        and(
          isNotNull(taskInteractions.runId),
          ne(sql<string>`trim(${taskInteractions.runId})`, ''),
        ),
      )
      .groupBy(taskInteractions.runId)
      .orderBy(desc(finishedAtExpr))
      .limit(limit);

    return rows.map((row) => ({
      runId: String(row.runId ?? ''),
      interactions: Number(row.interactions ?? 0),
      inputTokens: Number(row.inputTokens ?? 0),
      outputTokens: Number(row.outputTokens ?? 0),
      cost: Number(row.cost ?? 0),
      startedAt: String(row.startedAt ?? ''),
      finishedAt: String(row.finishedAt ?? ''),
    }));
  }

  async findRunIDsByPrefix(prefix: string, limit = 25): Promise<string[]> {
    const normalized = prefix.trim();
    if (!normalized) return [];
    const rows = await this.db
      .selectDistinct({ runId: taskInteractions.runId })
      .from(taskInteractions)
      .where(like(taskInteractions.runId, `${normalized}%`))
      .orderBy(desc(taskInteractions.runId))
      .limit(limit);

    return rows.map((row) => String(row.runId ?? '').trim()).filter(Boolean);
  }

  async listOperations(
    opts: { all?: boolean; sinceISO?: string; limit?: number } = {},
  ): Promise<StoredInteraction[]> {
    const limit = Math.max(1, opts.limit ?? 100);
    if (opts.all) {
      const rows = await this.db
        .select()
        .from(taskInteractions)
        .orderBy(desc(taskInteractions.startedAt))
        .limit(limit);
      return rows.map((row) => this.mapInteraction(row));
    }

    const sinceISO = opts.sinceISO?.trim() ?? '';
    if (!sinceISO) {
      const rows = await this.db
        .select()
        .from(taskInteractions)
        .where(eq(taskInteractions.status, INTERACTION_STATUSES.running))
        .orderBy(desc(taskInteractions.startedAt))
        .limit(limit);
      return rows.map((row) => this.mapInteraction(row));
    }

    const rows = await this.db
      .select()
      .from(taskInteractions)
      .where(
        or(
          eq(taskInteractions.status, INTERACTION_STATUSES.running),
          gte(taskInteractions.startedAt, sinceISO),
        ),
      )
      .orderBy(desc(taskInteractions.startedAt))
      .limit(limit);
    return rows.map((row) => this.mapInteraction(row));
  }

  async markStaleAsFailed(): Promise<void> {
    await this.db
      .update(taskInteractions)
      .set({
        status: INTERACTION_STATUSES.failed,
        error: sql`case
          when coalesce(${taskInteractions.error}, '') = '' then ${'operation interrupted: server restarted'}
          else ${taskInteractions.error}
        end`,
        finishedAt: sql`case
          when ${taskInteractions.finishedAt} is null then CURRENT_TIMESTAMP
          else ${taskInteractions.finishedAt}
        end`,
      })
      .where(eq(taskInteractions.status, INTERACTION_STATUSES.running));
  }

  async removeTaskLogs(taskID: string): Promise<void> {
    const normalized = taskID.trim();
    if (!normalized) return;
    const dir = `${this.baseDir}/${normalized}`;
    await Bun.$`rm -rf ${dir}`;
  }

  async supersedeReviewInteractions(taskID: string): Promise<void> {
    await this.db
      .update(taskInteractions)
      .set({
        status: INTERACTION_STATUSES.failed,
        error: sql`case
          when coalesce(${taskInteractions.error}, '') = '' then ${'superseded by revise rerun'}
          else ${taskInteractions.error}
        end`,
        finishedAt: sql`case
          when ${taskInteractions.finishedAt} is null then CURRENT_TIMESTAMP
          else ${taskInteractions.finishedAt}
        end`,
      })
      .where(
        and(
          eq(taskInteractions.taskId, taskID),
          eq(taskInteractions.type, 'review'),
          ne(taskInteractions.status, INTERACTION_STATUSES.failed),
        ),
      );
  }

  private async nextAttempt(
    taskID: string | null,
    type: string,
  ): Promise<number> {
    const rows = await this.db
      .select({
        attempt:
          sql<number>`coalesce(max(${taskInteractions.attempt}), 0) + 1`.as(
            'attempt',
          ),
      })
      .from(taskInteractions)
      .where(
        and(
          eq(taskInteractions.type, type),
          taskID === null
            ? isNull(taskInteractions.taskId)
            : eq(taskInteractions.taskId, taskID),
        ),
      );
    return Number(rows[0]?.attempt ?? 1);
  }

  private logPath(
    taskID: string | null,
    type: string,
    attempt: number,
    interactionID: string,
  ): string {
    const dir = taskID?.trim() ? taskID : '_project';
    return `${this.baseDir}/${dir}/${type}-${attempt}-${interactionID}.log`;
  }

  private dirName(path: string): string {
    const idx = path.lastIndexOf('/');
    if (idx < 0) return '.';
    return path.slice(0, idx);
  }

  private computeDiffSummary(diff: string | null | undefined): string | null {
    if (!diff) return null;
    let added = 0;
    let removed = 0;
    for (const line of diff.split('\n')) {
      if (line.startsWith('+++') || line.startsWith('---')) continue;
      if (line.startsWith('+')) {
        added++;
        continue;
      }
      if (line.startsWith('-')) removed++;
    }
    if (added === 0 && removed === 0) return null;
    return `+${added}/-${removed}`;
  }

  private mapStub(row: InteractionRow): InteractionStub {
    return {
      id: row.id,
      taskId: row.taskId,
      type: row.type,
      attempt: row.attempt,
      tool: row.tool,
      status: row.status as InteractionStatus,
      durationMs: row.durationMs ?? undefined,
      estimatedCost: Number(row.estimatedCost ?? 0),
      diffSummary: this.computeDiffSummary(row.diff),
      memoryCount: parseMemoryCount(row.qualityJson),
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
    };
  }

  private mapInteraction(row: InteractionRow): StoredInteraction {
    return {
      id: row.id,
      taskId: row.taskId,
      type: row.type,
      attempt: row.attempt,
      runId: row.runId,
      tool: row.tool,
      model: row.model,
      logPath: row.logPath,
      status: row.status as InteractionStatus,
      error: row.error ?? undefined,
      diff: row.diff ?? undefined,
      exitCode: row.exitCode ?? undefined,
      durationMs: row.durationMs ?? undefined,
      inputTokens: Number(row.inputTokens ?? 0),
      outputTokens: Number(row.outputTokens ?? 0),
      estimatedCost: Number(row.estimatedCost ?? 0),
      qualityJson: row.qualityJson ?? undefined,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
    };
  }
}

function parseMemoryCount(raw: string | null | undefined): number | undefined {
  if (!raw?.trim()) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const ids = parsed.usedMemoryIds ?? parsed.used_memory_ids;
    if (Array.isArray(ids) && ids.length > 0) return ids.length;
  } catch {
    /* ignore */
  }
  return undefined;
}
