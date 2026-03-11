import { appendFile } from 'node:fs/promises';
import { INTERACTION_STATUSES } from '@orca/types';
import {
  and,
  desc,
  eq,
  gte,
  isNotNull,
  isNull,
  ne,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { EventSink } from '../api/ws';
import type { OrcaDrizzleDB } from '../db/connection';
import { taskInteractions } from '../db/schema';
import type { InteractionStub } from '../types/models';
import { mapInteractionRow, mapInteractionStub } from './interaction-mappers';
import type { StoredInteraction } from './types';

interface BeginResult {
  id: string;
  attempt: number;
  logPath: string;
}

export class InteractionStore {
  constructor(
    private readonly db: OrcaDrizzleDB,
    private readonly baseDir = '.orca/logs/interactions',
    private readonly sink?: EventSink,
  ) {}

  async begin(input: {
    taskId?: string | null;
    type: string;
    stepName?: string;
    tool: string;
    previousInteractionId?: string | null;
  }): Promise<BeginResult> {
    const type = input.type.trim();
    const tool = input.tool.trim();
    if (!type) throw new Error('type required');
    if (!tool) throw new Error('tool required');

    const id = nanoid();
    const attempt = await this.nextAttempt(input.taskId ?? null, type);
    const logPath = this.logPath(input.taskId ?? null, type, attempt, id);

    await Bun.$`mkdir -p ${this.dirName(logPath)}`;
    await Bun.write(logPath, '');

    let previousId: string | null = input.previousInteractionId ?? null;
    if (!previousId && input.taskId) {
      const latest = await this.db
        .select({ id: taskInteractions.id })
        .from(taskInteractions)
        .where(eq(taskInteractions.taskId, input.taskId))
        .orderBy(desc(taskInteractions.startedAt), desc(taskInteractions.id))
        .limit(1);
      previousId = latest[0]?.id ?? null;
    }

    await this.db.insert(taskInteractions).values({
      id,
      taskId: input.taskId ?? null,
      type,
      stepName: input.stepName ?? null,
      attempt,
      tool,
      logPath,
      status: INTERACTION_STATUSES.running,
      startedAt: sql`(CURRENT_TIMESTAMP)`,
      previousInteractionId: previousId,
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
      output?: string | null;
      exitCode?: number;
      durationMs?: number;
      model?: string | null;
      commitSha?: string | null;
      sessionId?: string | null;
    },
  ): Promise<void> {
    const updates: {
      status: string;
      finishedAt: SQL;
      error?: string | null;
      output?: string | null;
      exitCode?: number;
      durationMs?: number;
      model?: string | null;
      commitSha?: string | null;
      sessionId?: string | null;
    } = {
      status: fields.status,
      finishedAt: sql`(CURRENT_TIMESTAMP)`,
    };

    if (fields.error !== undefined) updates.error = fields.error;
    if (fields.output !== undefined) updates.output = fields.output;
    if (fields.exitCode !== undefined) updates.exitCode = fields.exitCode;
    if (fields.durationMs !== undefined) updates.durationMs = fields.durationMs;
    if (fields.model !== undefined) updates.model = fields.model;
    if (fields.commitSha !== undefined) updates.commitSha = fields.commitSha;
    if (fields.sessionId !== undefined) updates.sessionId = fields.sessionId;

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

  async updateOutput(id: string, output: string): Promise<void> {
    const result = await this.db
      .update(taskInteractions)
      .set({ output })
      .where(eq(taskInteractions.id, id))
      .returning({ id: taskInteractions.id });
    if (result.length === 0) {
      throw new Error(`interaction ${id} not found`);
    }
    if (this.sink) {
      const interaction = await this.get(id);
      if (interaction) {
        this.sink.broadcast('interaction.updated', interaction);
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
    return row ? mapInteractionRow(row) : null;
  }

  async list(taskID: string): Promise<StoredInteraction[]> {
    const rows = await this.db
      .select()
      .from(taskInteractions)
      .where(eq(taskInteractions.taskId, taskID))
      .orderBy(desc(taskInteractions.startedAt), desc(taskInteractions.id));
    return rows.map(mapInteractionRow);
  }

  async listStubs(taskID: string): Promise<InteractionStub[]> {
    const rows = await this.db
      .select()
      .from(taskInteractions)
      .where(eq(taskInteractions.taskId, taskID))
      .orderBy(desc(taskInteractions.startedAt), desc(taskInteractions.id));
    return rows.map(mapInteractionStub);
  }

  async listByType(taskID: string, type: string): Promise<StoredInteraction[]> {
    const conditions = [
      eq(taskInteractions.taskId, taskID),
      eq(taskInteractions.type, type),
    ];
    const rows = await this.db
      .select()
      .from(taskInteractions)
      .where(and(...conditions))
      .orderBy(desc(taskInteractions.startedAt), desc(taskInteractions.id));
    return rows.map(mapInteractionRow);
  }

  async listByStepName(
    taskID: string,
    stepName: string,
  ): Promise<StoredInteraction[]> {
    const rows = await this.db
      .select()
      .from(taskInteractions)
      .where(
        and(
          eq(taskInteractions.taskId, taskID),
          eq(taskInteractions.stepName, stepName),
        ),
      )
      .orderBy(desc(taskInteractions.startedAt), desc(taskInteractions.id));
    return rows.map(mapInteractionRow);
  }

  async listByStatus(status: string): Promise<StoredInteraction[]> {
    const rows = await this.db
      .select()
      .from(taskInteractions)
      .where(eq(taskInteractions.status, status))
      .orderBy(desc(taskInteractions.startedAt), desc(taskInteractions.id));
    return rows.map(mapInteractionRow);
  }

  async listProjectByType(type: string): Promise<StoredInteraction[]> {
    const rows = await this.db
      .select()
      .from(taskInteractions)
      .where(eq(taskInteractions.type, type))
      .orderBy(desc(taskInteractions.startedAt), desc(taskInteractions.id));
    return rows.map(mapInteractionRow);
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

  async hasRunningForTask(taskID: string): Promise<boolean> {
    const rows = await this.db
      .select({ one: sql<number>`1`.as('one') })
      .from(taskInteractions)
      .where(
        and(
          eq(taskInteractions.taskId, taskID),
          eq(taskInteractions.status, INTERACTION_STATUSES.running),
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

  async listOperations(
    opts: { all?: boolean; sinceISO?: string; limit?: number } = {},
  ): Promise<StoredInteraction[]> {
    const limit = Math.max(1, opts.limit ?? 100);
    if (opts.all) {
      const rows = await this.db
        .select()
        .from(taskInteractions)
        .orderBy(desc(taskInteractions.startedAt), desc(taskInteractions.id))
        .limit(limit);
      return rows.map(mapInteractionRow);
    }

    const sinceISO = opts.sinceISO?.trim() ?? '';
    if (!sinceISO) {
      const rows = await this.db
        .select()
        .from(taskInteractions)
        .where(eq(taskInteractions.status, INTERACTION_STATUSES.running))
        .orderBy(desc(taskInteractions.startedAt), desc(taskInteractions.id))
        .limit(limit);
      return rows.map(mapInteractionRow);
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
    return rows.map(mapInteractionRow);
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

  async getLatestSessionId(taskID: string): Promise<string | null> {
    const rows = await this.db
      .select({ sessionId: taskInteractions.sessionId })
      .from(taskInteractions)
      .where(
        and(
          eq(taskInteractions.taskId, taskID),
          isNotNull(taskInteractions.sessionId),
        ),
      )
      .orderBy(desc(taskInteractions.startedAt), desc(taskInteractions.id))
      .limit(1);
    return rows[0]?.sessionId ?? null;
  }
}
