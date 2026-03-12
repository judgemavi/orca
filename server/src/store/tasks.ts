import { TASK_STATUSES, type TaskStatus } from '@orca/types';
import { and, asc, eq, inArray, ne, notExists, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type { EventSink } from '../api/ws';
import type { OrcaDrizzleDB } from '../db/connection';
import {
  type CreateTaskInput,
  type TaskEntry,
  taskDeps as taskDepsTable,
  tasks as tasksTable,
  type UpdateTaskInput,
} from '../db/schema';
import { mapTaskRow } from './task-mappers';

export async function createTask(
  db: OrcaDrizzleDB,
  sink: EventSink | undefined,
  input: CreateTaskInput,
): Promise<void> {
  const { dependsOn, ...rest } = input;

  if (dependsOn && dependsOn.length > 0) {
    const dependencies = await db
      .select()
      .from(tasksTable)
      .where(inArray(tasksTable.id, dependsOn));
    if (dependencies.length !== dependsOn.length) {
      throw new Error(
        `some of the dependencies do not exist: ${dependsOn.filter((id) => !dependencies.some((dep) => dep.id === id)).join(', ')}`,
      );
    }
  }

  const tasks = await db.insert(tasksTable).values(rest).returning();
  const task = tasks[0];
  if (!task) throw new Error('failed to create task');
  if (dependsOn && dependsOn.length > 0) {
    await Promise.all(
      dependsOn.map((id) => addDependency(db, sink, task.id, id)),
    );
  }
  sink?.broadcast('task.updated', task);
}

export async function getTask(
  db: OrcaDrizzleDB,
  id: string,
): Promise<TaskEntry> {
  const rows = await db
    .select()
    .from(tasksTable)
    .where(eq(tasksTable.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error(`task ${id} not found`);

  const deps = await loadDepsForTaskIDs(db, [id]);
  return mapTaskRow(row, deps.get(id) ?? []);
}

export async function listTasks(
  db: OrcaDrizzleDB,
  status?: TaskStatus,
): Promise<TaskEntry[]> {
  const tasks = await db
    .select()
    .from(tasksTable)
    .where(status && eq(tasksTable.status, status))
    .orderBy(asc(tasksTable.createdAt));
  const depsMap = await loadDepsForTaskIDs(
    db,
    tasks.map((task) => task.id),
  );

  return tasks.map((task) => mapTaskRow(task, depsMap.get(task.id) ?? []));
}

export async function updateTask(
  db: OrcaDrizzleDB,
  sink: EventSink | undefined,
  id: string,
  fields: Partial<UpdateTaskInput>,
): Promise<void> {
  if (Object.values(fields).every((value) => value === undefined)) {
    return;
  }

  await db
    .update(tasksTable)
    .set(fields)
    .where(eq(tasksTable.id, id))
    .returning({ id: tasksTable.id });
  sink?.broadcast('task.updated', id);
}

export async function deleteTask(
  db: OrcaDrizzleDB,
  sink: EventSink | undefined,
  id: string,
): Promise<void> {
  await db.delete(tasksTable).where(eq(tasksTable.id, id));
  sink?.broadcast('task.deleted', { id });
}

export async function setDependencies(
  db: OrcaDrizzleDB,
  sink: EventSink | undefined,
  taskID: string,
  dependsOnIDs: string[],
): Promise<void> {
  await db.delete(taskDepsTable).where(eq(taskDepsTable.taskId, taskID));
  for (const depID of dependsOnIDs) {
    await addDependency(db, sink, taskID, depID);
  }
}

export async function addDependency(
  db: OrcaDrizzleDB,
  sink: EventSink | undefined,
  taskID: string,
  dependsOnID: string,
): Promise<void> {
  await db
    .insert(taskDepsTable)
    .values({ taskId: taskID, dependsOn: dependsOnID });
  sink?.broadcast('task.updated', taskID);
}

export async function removeDependency(
  db: OrcaDrizzleDB,
  sink: EventSink | undefined,
  taskID: string,
  dependsOnID: string,
): Promise<void> {
  await db
    .delete(taskDepsTable)
    .where(
      and(
        eq(taskDepsTable.taskId, taskID),
        eq(taskDepsTable.dependsOn, dependsOnID),
      ),
    );
  sink?.broadcast('task.updated', taskID);
}

export async function getReadyTasks(db: OrcaDrizzleDB): Promise<TaskEntry[]> {
  const depsAlias = alias(taskDepsTable, 'd');
  const depTaskAlias = alias(tasksTable, 'dep');
  const blockingDeps = db
    .select({ one: sql<number>`1` })
    .from(depsAlias)
    .innerJoin(depTaskAlias, eq(depTaskAlias.id, depsAlias.dependsOn))
    .where(
      and(
        eq(depsAlias.taskId, tasksTable.id),
        ne(depTaskAlias.status, TASK_STATUSES.merged),
      ),
    );

  const rows = await db
    .select()
    .from(tasksTable)
    .where(
      and(
        eq(tasksTable.status, TASK_STATUSES.planned),
        notExists(blockingDeps),
      ),
    )
    .orderBy(asc(tasksTable.createdAt));
  const deps = await loadDepsForTaskIDs(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => mapTaskRow(row, deps.get(row.id) ?? []));
}

export async function areDependenciesMet(
  db: OrcaDrizzleDB,
  taskID: string,
): Promise<boolean> {
  const depsAlias = alias(taskDepsTable, 'd');
  const depTaskAlias = alias(tasksTable, 'dep');
  const blocking = await db
    .select({ one: sql<number>`1` })
    .from(depsAlias)
    .innerJoin(depTaskAlias, eq(depTaskAlias.id, depsAlias.dependsOn))
    .where(
      and(
        eq(depsAlias.taskId, taskID),
        ne(depTaskAlias.status, TASK_STATUSES.merged),
      ),
    )
    .limit(1);
  return blocking.length === 0;
}

export async function getUnblockedDependents(
  db: OrcaDrizzleDB,
  mergedTaskId: string,
): Promise<TaskEntry[]> {
  const dependentRows = await db
    .select({ taskId: taskDepsTable.taskId })
    .from(taskDepsTable)
    .where(eq(taskDepsTable.dependsOn, mergedTaskId));

  if (dependentRows.length === 0) return [];

  const candidateIds = dependentRows.map((r) => r.taskId);
  const depsAlias = alias(taskDepsTable, 'd');
  const depTaskAlias = alias(tasksTable, 'dep');
  const blockingDeps = db
    .select({ one: sql<number>`1` })
    .from(depsAlias)
    .innerJoin(depTaskAlias, eq(depTaskAlias.id, depsAlias.dependsOn))
    .where(
      and(
        eq(depsAlias.taskId, tasksTable.id),
        ne(depTaskAlias.status, TASK_STATUSES.merged),
      ),
    );

  const rows = await db
    .select()
    .from(tasksTable)
    .where(
      and(
        inArray(tasksTable.id, candidateIds),
        inArray(tasksTable.status, [
          TASK_STATUSES.pending,
          TASK_STATUSES.planned,
        ]),
        notExists(blockingDeps),
      ),
    )
    .orderBy(asc(tasksTable.createdAt));

  const deps = await loadDepsForTaskIDs(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((row) => mapTaskRow(row, deps.get(row.id) ?? []));
}

async function loadDepsForTaskIDs(
  db: OrcaDrizzleDB,
  taskIDs: string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (const id of taskIDs) {
    out.set(id, []);
  }
  if (taskIDs.length === 0) return out;

  const rows = await db
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
