import { Database } from 'bun:sqlite';
import { sql } from 'drizzle-orm';
import { type BunSQLiteDatabase, drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import * as schema from './schema';

export type OrcaDrizzleDB = BunSQLiteDatabase<typeof schema>;

export interface OpenDatabaseOptions {
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
  sqlite.exec('PRAGMA foreign_keys = ON');

  const db = drizzle(sqlite, { schema });

  migrate(db, { migrationsFolder });

  // FTS5 virtual table for memory search — standalone (not content-synced)
  db.run(sql`
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_entries_fts
    USING fts5(id UNINDEXED, content, tags)
  `);

  return {
    db,
    close: () => {
      sqlite.close();
    },
  };
}
