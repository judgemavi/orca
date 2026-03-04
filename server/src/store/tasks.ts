import {
  and,
  asc,
  desc,
  eq,
  inArray,
  like,
  ne,
  notExists,
  notInArray,
  type SQL,
  sql,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type { EventSink } from '../api/ws';
import type { OrcaDrizzleDB } from '../db/connection';
import {
  taskDeps as taskDepsTable,
  taskFileAssociations as taskFileAssociationsTable,
  taskInteractions as taskInteractionsTable,
  taskReviews as taskReviewsTable,
  tasks as tasksTable,
} from '../db/schema';
import type { Task, TaskReview, TaskStatus } from '../types';
import { REVIEW_STATUSES, TASK_STATUSES } from '../types';
import { detectCycle, topoSort } from './graph';
import type { TaskCreateInput, TaskUpdateFields } from './types';

const DELETABLE_STATUS = new Set<TaskStatus>([
  TASK_STATUSES.pending,
  TASK_STATUSES.planned,
  TASK_STATUSES.review,
  TASK_STATUSES.approved,
  TASK_STATUSES.failed,
  TASK_STATUSES.stopped,
]);

type TaskRow = typeof tasksTable.$inferSelect;

export class TaskStore {
  constructor(
    private readonly db: OrcaDrizzleDB,
    private readonly sink?: EventSink,
  ) {}

  async create(input: TaskCreateInput): Promise<Task> {
    const id = input.id?.trim() || crypto.randomUUID();
    const title = input.title.trim();
    if (!title) throw new Error('title required');

    await this.db.insert(tasksTable).values({
      id,
      title,
      description: input.description ?? '',
      parentId: input.parentId ?? null,
      status: TASK_STATUSES.pending,
      createdAt: sql`(CURRENT_TIMESTAMP)`,
      updatedAt: sql`(CURRENT_TIMESTAMP)`,
    });

    const task = await this.get(id);
    if (!task) throw new Error(`failed to create task: ${id}`);
    this.sink?.broadcast('task.updated', task);
    return task;
  }

  async get(id: string): Promise<Task | null> {
    const rows = await this.db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.id, id))
      .limit(1);
    const row = rows[0] ?? null;
    if (!row) return null;
    const deps = await this.loadDeps(id);
    return this.mapTask(row, deps);
  }

  async list(): Promise<Task[]> {
    const rows = await this.db
      .select()
      .from(tasksTable)
      .orderBy(asc(tasksTable.createdAt));
    const deps = await this.loadDepsForTaskIDs(rows.map((row) => row.id));
    return rows.map((row) => this.mapTask(row, deps.get(row.id) ?? []));
  }

  async listByStatus(status: TaskStatus): Promise<Task[]> {
    const rows = await this.db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.status, status))
      .orderBy(asc(tasksTable.createdAt));
    const deps = await this.loadDepsForTaskIDs(rows.map((row) => row.id));
    return rows.map((row) => this.mapTask(row, deps.get(row.id) ?? []));
  }

  async resolveID(prefix: string): Promise<string> {
    const normalized = prefix.trim();
    if (normalized.length === 36) return normalized;
    const rows = await this.db
      .select({ id: tasksTable.id })
      .from(tasksTable)
      .where(like(tasksTable.id, `${normalized}%`))
      .orderBy(asc(tasksTable.id));
    if (rows.length === 0)
      throw new Error(`no task matching prefix ${JSON.stringify(normalized)}`);
    if (rows.length > 1) {
      throw new Error(
        `ambiguous prefix ${JSON.stringify(normalized)} matches ${rows.length} tasks`,
      );
    }
    if (!rows[0])
      throw new Error(`no task matching prefix ${JSON.stringify(normalized)}`);
    return rows[0].id;
  }

  async update(id: string, fields: TaskUpdateFields): Promise<void> {
    const updateSet: Partial<{
      title: string;
      description: string;
      plan: string | null;
      status: TaskStatus;
      sessionId: string | null;
      updatedAt: SQL;
    }> = {};

    if (fields.title !== undefined) updateSet.title = fields.title;
    if (fields.description !== undefined)
      updateSet.description = fields.description;
    if (fields.plan !== undefined) updateSet.plan = fields.plan;
    if (fields.status !== undefined) updateSet.status = fields.status;
    if (fields.sessionId !== undefined) updateSet.sessionId = fields.sessionId;

    if (Object.keys(updateSet).length === 0) return;

    updateSet.updatedAt = sql`(CURRENT_TIMESTAMP)`;

    const result = await this.db
      .update(tasksTable)
      .set(updateSet)
      .where(eq(tasksTable.id, id))
      .returning({ id: tasksTable.id });
    if (result.length === 0) {
      throw new Error(`task ${id} not found`);
    }

    if (this.sink) {
      const task = await this.get(id);
      if (task) this.sink.broadcast('task.updated', task);
    }
  }

  async updateStatus(id: string, status: TaskStatus): Promise<Task> {
    await this.update(id, { status });
    const updated = await this.get(id);
    if (!updated) throw new Error(`task not found: ${id}`);
    return updated;
  }

  async delete(id: string): Promise<void> {
    const task = await this.get(id);
    if (!task) throw new Error(`task ${id} not found`);
    if (!DELETABLE_STATUS.has(task.status)) {
      throw new Error(
        `cannot delete task in ${JSON.stringify(task.status)} status`,
      );
    }

    const dependentCountRows = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(taskDepsTable)
      .where(eq(taskDepsTable.dependsOn, id));
    const dependentCount = Number(dependentCountRows[0]?.count ?? 0);
    if (dependentCount > 0) {
      throw new Error(
        `cannot delete task: ${dependentCount} other task(s) depend on it`,
      );
    }

    await this.db.transaction(async (tx) => {
      await tx.delete(taskReviewsTable).where(eq(taskReviewsTable.taskId, id));
      await tx
        .delete(taskInteractionsTable)
        .where(eq(taskInteractionsTable.taskId, id));
      await tx.delete(taskDepsTable).where(eq(taskDepsTable.taskId, id));
      await tx
        .delete(taskFileAssociationsTable)
        .where(eq(taskFileAssociationsTable.taskId, id));
      await tx.delete(tasksTable).where(eq(tasksTable.id, id));
    });
    this.sink?.broadcast('task.deleted', { id });
  }

  async addDependency(taskID: string, dependsOnID: string): Promise<void> {
    const next = await this.loadDeps(taskID);
    next.push(dependsOnID);
    await this.updateDependencies(taskID, next);
  }

  async removeDependency(taskID: string, dependsOnID: string): Promise<void> {
    await this.db
      .delete(taskDepsTable)
      .where(
        and(
          eq(taskDepsTable.taskId, taskID),
          eq(taskDepsTable.dependsOn, dependsOnID),
        ),
      );
  }

  async updateDependencies(taskID: string, deps: string[]): Promise<void> {
    const graph = await this.loadDependencyGraph();
    graph.set(taskID, normalizeStringList(deps));

    const cycle = detectCycle(
      [...graph.keys()],
      (nodeID) => graph.get(nodeID) ?? [],
    );
    if (cycle) {
      throw new Error(`circular dependency: ${cycle.join(' -> ')}`);
    }

    const normalized = graph.get(taskID) ?? [];
    await this.db.transaction(async (tx) => {
      await tx.delete(taskDepsTable).where(eq(taskDepsTable.taskId, taskID));
      for (const dep of normalized) {
        await tx
          .insert(taskDepsTable)
          .values({ taskId: taskID, dependsOn: dep });
      }
    });
  }

  async getReady(): Promise<Task[]> {
    const depsAlias = alias(taskDepsTable, 'd');
    const depTaskAlias = alias(tasksTable, 'dep');
    const blockingDeps = this.db
      .select({ one: sql<number>`1` })
      .from(depsAlias)
      .innerJoin(depTaskAlias, eq(depTaskAlias.id, depsAlias.dependsOn))
      .where(
        and(
          eq(depsAlias.taskId, tasksTable.id),
          ne(depTaskAlias.status, TASK_STATUSES.merged),
        ),
      );

    const rows = await this.db
      .select()
      .from(tasksTable)
      .where(
        and(
          eq(tasksTable.status, TASK_STATUSES.planned),
          notExists(blockingDeps),
        ),
      )
      .orderBy(asc(tasksTable.createdAt));
    const deps = await this.loadDepsForTaskIDs(rows.map((row) => row.id));
    return rows.map((row) => this.mapTask(row, deps.get(row.id) ?? []));
  }

  async setPlan(id: string, content: string): Promise<void> {
    await this.update(id, { plan: content });
  }

  async getPlan(id: string): Promise<string> {
    const rows = await this.db
      .select({ plan: tasksTable.plan })
      .from(tasksTable)
      .where(eq(tasksTable.id, id))
      .limit(1);
    const row = rows[0] ?? null;
    if (!row) throw new Error(`task ${id} not found`);
    return row.plan ?? '';
  }

  async setSessionID(id: string, sessionID: string): Promise<void> {
    await this.update(id, { sessionId: sessionID || null });
  }

  async addReview(
    taskID: string,
    feedback: string,
    interactionID = '',
  ): Promise<string> {
    const id = crypto.randomUUID();
    await this.db.insert(taskReviewsTable).values({
      id,
      taskId: taskID,
      interactionId: interactionID.trim() || null,
      feedback,
      status: REVIEW_STATUSES.pending,
    });
    return id;
  }

  async getPendingReview(
    taskID: string,
  ): Promise<{ id: string; feedback: string } | null> {
    const rows = await this.db
      .select({
        id: taskReviewsTable.id,
        feedback: taskReviewsTable.feedback,
      })
      .from(taskReviewsTable)
      .where(
        and(
          eq(taskReviewsTable.taskId, taskID),
          eq(taskReviewsTable.status, REVIEW_STATUSES.pending),
        ),
      )
      .orderBy(desc(taskReviewsTable.createdAt))
      .limit(1);
    return rows[0] ?? null;
  }

  async addressReview(reviewID: string): Promise<void> {
    await this.db
      .update(taskReviewsTable)
      .set({
        status: REVIEW_STATUSES.addressed,
        addressedAt: sql`(CURRENT_TIMESTAMP)`,
      })
      .where(eq(taskReviewsTable.id, reviewID));
  }

  async listReviews(taskID: string): Promise<TaskReview[]> {
    const rows = await this.db
      .select()
      .from(taskReviewsTable)
      .where(eq(taskReviewsTable.taskId, taskID))
      .orderBy(asc(taskReviewsTable.createdAt));

    return rows.map((row) => ({
      id: row.id,
      taskId: row.taskId,
      interactionId: row.interactionId ?? undefined,
      feedback: row.feedback,
      status: row.status as TaskReview['status'],
      createdAt: row.createdAt,
      addressedAt: row.addressedAt ?? undefined,
    }));
  }

  async associateFiles(taskID: string, paths: string[]): Promise<void> {
    const normalized = normalizeStringList(paths);
    if (!taskID.trim() || normalized.length === 0) return;

    for (const path of normalized) {
      await this.db
        .insert(taskFileAssociationsTable)
        .values({
          taskId: taskID,
          filePath: path,
        })
        .onConflictDoNothing({
          target: [
            taskFileAssociationsTable.taskId,
            taskFileAssociationsTable.filePath,
          ],
        });
    }
  }

  async getFilePaths(taskID: string): Promise<string[]> {
    if (!taskID.trim()) return [];
    const rows = await this.db
      .select({ filePath: taskFileAssociationsTable.filePath })
      .from(taskFileAssociationsTable)
      .where(eq(taskFileAssociationsTable.taskId, taskID))
      .orderBy(asc(taskFileAssociationsTable.filePath));
    return rows.map((row) => String(row.filePath));
  }

  async findTasksByFilePaths(
    paths: string[],
    excludeStatuses: string[] = [],
  ): Promise<string[]> {
    const normalizedPaths = normalizeStringList(paths);
    if (normalizedPaths.length === 0) return [];

    const statusFilters = normalizeStringList(excludeStatuses);
    const latestUpdatedAt = sql<string>`max(${tasksTable.updatedAt})`;
    const whereClause =
      statusFilters.length > 0
        ? and(
            inArray(taskFileAssociationsTable.filePath, normalizedPaths),
            notInArray(tasksTable.status, statusFilters),
          )
        : inArray(taskFileAssociationsTable.filePath, normalizedPaths);

    const rows = await this.db
      .select({
        taskId: taskFileAssociationsTable.taskId,
        latestUpdatedAt: latestUpdatedAt,
      })
      .from(taskFileAssociationsTable)
      .innerJoin(
        tasksTable,
        eq(tasksTable.id, taskFileAssociationsTable.taskId),
      )
      .where(whereClause)
      .groupBy(taskFileAssociationsTable.taskId)
      .orderBy(desc(latestUpdatedAt));
    return rows.map((row) => String(row.taskId));
  }

  async sortTasksTopologically(taskIDs: string[]): Promise<string[]> {
    const graph = await this.loadDependencyGraph();
    return topoSort(taskIDs, (taskID) => graph.get(taskID) ?? []);
  }

  private mapTask(row: TaskRow, dependsOn: string[]): Task {
    return {
      id: row.id,
      title: row.title,
      description: row.description ?? '',
      parentId: row.parentId,
      sessionId: row.sessionId ?? undefined,
      status: row.status as TaskStatus,
      dependsOn: dependsOn,
      plan: row.plan,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private async loadDeps(taskID: string): Promise<string[]> {
    const rows = await this.db
      .select({ dependsOn: taskDepsTable.dependsOn })
      .from(taskDepsTable)
      .where(eq(taskDepsTable.taskId, taskID))
      .orderBy(asc(taskDepsTable.dependsOn));
    return rows.map((row) => String(row.dependsOn));
  }

  private async loadDepsForTaskIDs(
    taskIDs: string[],
  ): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    for (const id of taskIDs) {
      out.set(id, []);
    }
    if (taskIDs.length === 0) return out;

    const rows = await this.db
      .select({
        taskId: taskDepsTable.taskId,
        dependsOn: taskDepsTable.dependsOn,
      })
      .from(taskDepsTable)
      .where(inArray(taskDepsTable.taskId, taskIDs))
      .orderBy(asc(taskDepsTable.taskId), asc(taskDepsTable.dependsOn));

    for (const row of rows) {
      const deps = out.get(row.taskId) ?? [];
      deps.push(row.dependsOn);
      out.set(row.taskId, deps);
    }

    for (const [id, deps] of out.entries()) {
      out.set(
        id,
        [...deps].sort((a, b) => a.localeCompare(b)),
      );
    }

    return out;
  }

  private async loadDependencyGraph(): Promise<Map<string, string[]>> {
    const graph = new Map<string, string[]>();
    const taskRows = await this.db
      .select({ id: tasksTable.id })
      .from(tasksTable)
      .orderBy(asc(tasksTable.id));
    for (const task of taskRows) {
      graph.set(task.id, []);
    }
    const edges = await this.db
      .select({
        taskId: taskDepsTable.taskId,
        dependsOn: taskDepsTable.dependsOn,
      })
      .from(taskDepsTable)
      .orderBy(asc(taskDepsTable.taskId), asc(taskDepsTable.dependsOn));
    for (const edge of edges) {
      const deps = graph.get(edge.taskId) ?? [];
      deps.push(edge.dependsOn);
      graph.set(edge.taskId, deps);
    }
    return graph;
  }
}

function normalizeStringList(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out.sort((a, b) => a.localeCompare(b));
}
