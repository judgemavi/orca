import { Database } from 'bun:sqlite';
import { sql } from 'drizzle-orm';
import { type BunSQLiteDatabase, drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import * as schema from './schema';

export type OrcaDrizzleDB = BunSQLiteDatabase<typeof schema>;

interface OpenDatabaseOptions {
  repoDir: string;
  dbPath?: string;
  migrationsFolder?: string;
}

export interface DatabaseConnection {
  db: OrcaDrizzleDB;
  close: () => void;
}

export function openDatabase(options: OpenDatabaseOptions): DatabaseConnection {
  const dbPath = options.dbPath ?? `${options.repoDir}/.orca/state.db`;
  const migrationsFolder =
    options.migrationsFolder ??
    new URL('../../drizzle', import.meta.url).pathname;

  const sqlite = new Database(dbPath, { create: true });
  sqlite.exec('PRAGMA journal_mode = WAL');
  sqlite.exec('PRAGMA busy_timeout = 5000');
  sqlite.exec('PRAGMA foreign_keys = ON');

  const db = drizzle(sqlite, { schema });

  migrate(db, { migrationsFolder });

  // Change-tracking triggers (drizzle can't generate these)
  createChangelogTriggers(db);

  return {
    db,
    close: () => {
      sqlite.close();
    },
  };
}

const TRACKED_TABLES = [
  { table: 'tasks', idCol: 'id' },
  { table: 'task_interactions', idCol: 'id' },
  { table: 'task_reviews', idCol: 'id' },
  { table: 'jobs', idCol: 'id' },
  { table: 'memory_entries', idCol: 'id' },
  { table: 'config', idCol: 'key' },
] as const;

function createChangelogTriggers(db: OrcaDrizzleDB) {
  for (const { table, idCol } of TRACKED_TABLES) {
    for (const action of ['insert', 'update', 'delete'] as const) {
      const ref = action === 'delete' ? 'OLD' : 'NEW';
      const name = `${table}_after_${action}`;
      const timing =
        action === 'delete'
          ? 'AFTER DELETE'
          : action === 'insert'
            ? 'AFTER INSERT'
            : 'AFTER UPDATE';
      db.run(
        sql.raw(`
        CREATE TRIGGER IF NOT EXISTS ${name} ${timing} ON ${table}
        BEGIN
          INSERT INTO _changelog(table_name, row_id, action) VALUES ('${table}', ${ref}.${idCol}, '${action}');
        END
      `),
      );
    }
  }
}
