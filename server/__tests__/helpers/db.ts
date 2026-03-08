import { type DatabaseConnection, openDatabase } from '../../src/db/connection';
import { JobQueue } from '../../src/queue/queue';
import { ConfigStore } from '../../src/store/config';
import { TaskStore } from '../../src/store/tasks';

export function createTestDB(): DatabaseConnection {
  return openDatabase({ repoDir: '', dbPath: ':memory:' });
}

export interface TestContext extends DatabaseConnection {
  taskStore: TaskStore;
  queue: JobQueue;
  configStore: ConfigStore;
}

export function createTestContext(): TestContext {
  const conn = createTestDB();
  return {
    ...conn,
    taskStore: new TaskStore(conn.db),
    queue: new JobQueue(conn.db),
    configStore: new ConfigStore(conn.db),
  };
}
