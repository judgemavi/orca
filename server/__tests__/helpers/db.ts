import type { EventSink } from '../../src/api/ws';
import { nanoid } from 'nanoid';
import { type DatabaseConnection, openDatabase } from '../../src/db/connection';
import { JobQueue } from '../../src/queue/queue';
import { InteractionStore } from '../../src/store/interactions';
import * as taskStoreFns from '../../src/store/tasks';

export function createTestDB(): DatabaseConnection {
  return openDatabase({ repoDir: '', dbPath: ':memory:' });
}

function makeTaskFacade(conn: DatabaseConnection) {
  const db = conn.db;
  return {
    create: async (input: Parameters<typeof taskStoreFns.createTask>[2]) => {
      const id = input.id ?? nanoid();
      await taskStoreFns.createTask(db, undefined, { ...input, id });
      return taskStoreFns.getTask(db, id);
    },
    get: (id: string) => taskStoreFns.getTask(db, id),
    list: (status?: Parameters<typeof taskStoreFns.listTasks>[1]) =>
      taskStoreFns.listTasks(db, status),
    update: (id: string, fields: Parameters<typeof taskStoreFns.updateTask>[3]) =>
      taskStoreFns.updateTask(db, undefined, id, fields),
    updateStatus: (id: string, status: Parameters<typeof taskStoreFns.updateTaskStatus>[3]) =>
      taskStoreFns.updateTaskStatus(db, undefined, id, status),
    delete: (id: string) => taskStoreFns.deleteTask(db, undefined, id),
  };
}

export interface TestContext extends DatabaseConnection {
  interactionStore: InteractionStore;
  queue: JobQueue;
  taskStore: ReturnType<typeof makeTaskFacade>;
}

export function createTestContext(sink?: EventSink): TestContext {
  const conn = createTestDB();
  return {
    ...conn,
    interactionStore: new InteractionStore(conn.db, undefined, sink),
    queue: new JobQueue(conn.db, sink),
    taskStore: makeTaskFacade(conn),
  };
}
