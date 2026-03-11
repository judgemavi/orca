import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { drizzle, type SQLiteBunDatabase } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import * as schema from './schema';

export type OrcaDrizzleDB = SQLiteBunDatabase<typeof schema>;

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

  ensureDatabaseParentDir(dbPath);

  const sqlite = new Database(dbPath, { create: true });
  sqlite.exec('PRAGMA journal_mode = WAL');
  sqlite.exec('PRAGMA busy_timeout = 5000');
  sqlite.exec('PRAGMA foreign_keys = ON');

  const db = drizzle({ client: sqlite, schema });

  migrate(db, { migrationsFolder });

  return {
    db,
    close: () => {
      sqlite.close();
    },
  };
}

function ensureDatabaseParentDir(dbPath: string) {
  if (!dbPath || dbPath === ':memory:' || dbPath.startsWith('file:')) {
    return;
  }

  mkdirSync(dirname(dbPath), { recursive: true });
}
