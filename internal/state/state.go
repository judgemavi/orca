// Package state manages SQLite persistence for tasks and interaction context.
package state

import (
	"database/sql"
	"fmt"
	_ "github.com/mattn/go-sqlite3"
)

// DB wraps a SQLite connection with Orca-specific operations.
type DB struct {
	*sql.DB
}

// Open opens a SQLite database at dbPath, enables WAL mode and foreign keys,
// and runs schema migrations.
func Open(dbPath string) (*DB, error) {
	sqlDB, err := sql.Open("sqlite3", dbPath)
	if err != nil {
		return nil, fmt.Errorf("open db: %w", err)
	}

	// Enable WAL mode for concurrent reads.
	if _, err := sqlDB.Exec("PRAGMA journal_mode=WAL"); err != nil {
		sqlDB.Close()
		return nil, fmt.Errorf("enable WAL: %w", err)
	}

	// Enable foreign key enforcement.
	if _, err := sqlDB.Exec("PRAGMA foreign_keys=ON"); err != nil {
		sqlDB.Close()
		return nil, fmt.Errorf("enable foreign keys: %w", err)
	}

	db := &DB{sqlDB}
	if err := db.migrate(); err != nil {
		sqlDB.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}

	return db, nil
}

func (db *DB) migrate() error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if _, err := tx.Exec(`
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version    INTEGER PRIMARY KEY,
			applied_at DATETIME NOT NULL
		)
	`); err != nil {
		return err
	}

	currentVersion, err := db.currentMigrationVersion(tx)
	if err != nil {
		return err
	}

	for _, m := range migrations {
		if m.version <= currentVersion {
			continue
		}

		applied, err := m.isApplied(tx)
		if err != nil {
			return err
		}
		if !applied {
			if _, err := tx.Exec(m.sql); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(
			`INSERT INTO schema_migrations(version, applied_at) VALUES (?, CURRENT_TIMESTAMP)`,
			m.version,
		); err != nil {
			return err
		}
	}

	return tx.Commit()
}

func (db *DB) currentMigrationVersion(tx *sql.Tx) (int, error) {
	var version sql.NullInt64
	if err := tx.QueryRow(`SELECT MAX(version) FROM schema_migrations`).Scan(&version); err != nil {
		return 0, err
	}
	if !version.Valid {
		return 0, nil
	}
	return int(version.Int64), nil
}

type migration struct {
	version   int
	sql       string
	isApplied func(tx *sql.Tx) (bool, error)
}

var migrations = []migration{
	{
		version:   1,
		sql:       schemaV1,
		isApplied: schemaV1Applied,
	},
	{
		version:   2,
		sql:       schemaV2,
		isApplied: schemaV2Applied,
	},
	{
		version:   3,
		sql:       schemaV3,
		isApplied: schemaV3Applied,
	},
	{
		version:   4,
		sql:       schemaV4,
		isApplied: schemaV4Applied,
	},
	{
		version:   5,
		sql:       schemaV5,
		isApplied: schemaV5Applied,
	},
}

// DBVersion returns the current persisted db_version sentinel value.
func (db *DB) DBVersion() (int64, error) {
	var version int64
	if err := db.QueryRow(
		`SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'db_version'`,
	).Scan(&version); err != nil {
		return 0, err
	}
	return version, nil
}

func schemaV1Applied(tx *sql.Tx) (bool, error) {
	tables := []string{
		"tasks",
		"task_deps",
		"task_reviews",
		"task_interactions",
		"sessions",
	}
	for _, table := range tables {
		exists, err := hasTable(tx, table)
		if err != nil {
			return false, err
		}
		if !exists {
			return false, nil
		}
	}
	return true, nil
}

func schemaV2Applied(tx *sql.Tx) (bool, error) {
	return hasColumn(tx, "task_reviews", "interaction_id")
}

func schemaV3Applied(tx *sql.Tx) (bool, error) {
	return hasTable(tx, "config")
}

func schemaV4Applied(tx *sql.Tx) (bool, error) {
	return hasTable(tx, "knowledge_entries")
}

func schemaV5Applied(tx *sql.Tx) (bool, error) {
	tableExists, err := hasTable(tx, "explore_context")
	if err != nil {
		return false, err
	}
	if !tableExists {
		return false, nil
	}

	insertTrigger, err := hasTrigger(tx, "explore_context_version_insert")
	if err != nil {
		return false, err
	}
	if !insertTrigger {
		return false, nil
	}

	updateTrigger, err := hasTrigger(tx, "explore_context_version_update")
	if err != nil {
		return false, err
	}
	return updateTrigger, nil
}

func hasTable(tx *sql.Tx, table string) (bool, error) {
	var count int
	if err := tx.QueryRow(
		`SELECT COUNT(1) FROM sqlite_master WHERE type = 'table' AND name = ?`,
		table,
	).Scan(&count); err != nil {
		return false, err
	}
	return count > 0, nil
}

func hasTrigger(tx *sql.Tx, trigger string) (bool, error) {
	var count int
	if err := tx.QueryRow(
		`SELECT COUNT(1) FROM sqlite_master WHERE type = 'trigger' AND name = ?`,
		trigger,
	).Scan(&count); err != nil {
		return false, err
	}
	return count > 0, nil
}

func hasColumn(tx *sql.Tx, table, column string) (bool, error) {
	rows, err := tx.Query(fmt.Sprintf(`PRAGMA table_info(%s)`, table))
	if err != nil {
		return false, err
	}
	defer rows.Close()

	for rows.Next() {
		var cid int
		var name string
		var columnType string
		var notNull int
		var defaultValue sql.NullString
		var pk int
		if err := rows.Scan(&cid, &name, &columnType, &notNull, &defaultValue, &pk); err != nil {
			return false, err
		}
		if name == column {
			return true, nil
		}
	}
	if err := rows.Err(); err != nil {
		return false, err
	}
	return false, nil
}

const schemaV1 = `
CREATE TABLE IF NOT EXISTS schema_migrations (
	version    INTEGER PRIMARY KEY,
	applied_at DATETIME NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
	id            TEXT PRIMARY KEY,
	title         TEXT NOT NULL,
	description   TEXT,
	plan          TEXT,
	session_id    TEXT,
	parent_id     TEXT REFERENCES tasks(id),
	status        TEXT NOT NULL DEFAULT 'pending',
	created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
	updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS task_deps (
	task_id    TEXT NOT NULL REFERENCES tasks(id),
	depends_on TEXT NOT NULL REFERENCES tasks(id),
	PRIMARY KEY (task_id, depends_on)
);

CREATE TABLE IF NOT EXISTS task_reviews (
	id           TEXT PRIMARY KEY,
	task_id      TEXT NOT NULL REFERENCES tasks(id),
	feedback     TEXT NOT NULL,
	status       TEXT NOT NULL DEFAULT 'pending',
	created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
	addressed_at DATETIME
);

CREATE TABLE IF NOT EXISTS task_interactions (
	id             TEXT PRIMARY KEY,
	task_id        TEXT REFERENCES tasks(id),
	phase          TEXT NOT NULL,
	attempt        INTEGER NOT NULL DEFAULT 1,
	run_id         TEXT,
	tool           TEXT NOT NULL,
	model          TEXT,
	log_path       TEXT NOT NULL,
	status         TEXT NOT NULL DEFAULT 'running',
	error          TEXT,
	diff           TEXT,
	exit_code      INTEGER,
	duration_ms    INTEGER,
	quality_json   TEXT,
	input_tokens   INTEGER DEFAULT 0,
	output_tokens  INTEGER DEFAULT 0,
	estimated_cost REAL DEFAULT 0.0,
	started_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
	finished_at    DATETIME
);

CREATE INDEX IF NOT EXISTS idx_interactions_task_phase
	ON task_interactions(task_id, phase);

CREATE INDEX IF NOT EXISTS idx_interactions_status
	ON task_interactions(status);

CREATE TABLE IF NOT EXISTS sessions (
	id          TEXT PRIMARY KEY,
	type        TEXT NOT NULL,
	tool        TEXT NOT NULL,
	task_id     TEXT,
	pid         INTEGER NOT NULL,
	working_dir TEXT,
	cols        INTEGER DEFAULT 80,
	rows        INTEGER DEFAULT 24,
	status      TEXT NOT NULL DEFAULT 'running',
	exit_code   INTEGER DEFAULT -1,
	created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
	exited_at   DATETIME
);

CREATE TABLE IF NOT EXISTS meta (
	key   TEXT PRIMARY KEY,
	value TEXT NOT NULL
);

INSERT OR IGNORE INTO meta (key, value) VALUES ('db_version', '0');

CREATE TRIGGER IF NOT EXISTS tasks_version_insert
AFTER INSERT ON tasks
BEGIN
	UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'db_version';
END;

CREATE TRIGGER IF NOT EXISTS tasks_version_update
AFTER UPDATE ON tasks
BEGIN
	UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'db_version';
END;

CREATE TRIGGER IF NOT EXISTS tasks_version_delete
AFTER DELETE ON tasks
BEGIN
	UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'db_version';
END;

CREATE TRIGGER IF NOT EXISTS interactions_version_insert
AFTER INSERT ON task_interactions
BEGIN
	UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'db_version';
END;

CREATE TRIGGER IF NOT EXISTS interactions_version_update
AFTER UPDATE ON task_interactions
BEGIN
	UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'db_version';
END;

CREATE TRIGGER IF NOT EXISTS sessions_version_insert
AFTER INSERT ON sessions
BEGIN
	UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'db_version';
END;

CREATE TRIGGER IF NOT EXISTS sessions_version_update
AFTER UPDATE ON sessions
BEGIN
	UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'db_version';
END;
`

const schemaV2 = `
ALTER TABLE task_reviews ADD COLUMN interaction_id TEXT REFERENCES task_interactions(id);
`

const schemaV3 = `
CREATE TABLE IF NOT EXISTS config (
	key   TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
`

const schemaV4 = `
CREATE TABLE IF NOT EXISTS knowledge_entries (
	id                    TEXT PRIMARY KEY,
	content               TEXT NOT NULL,
	category              TEXT NOT NULL CHECK(category IN ('pattern','pitfall','preference','convention')),
	tags                  TEXT NOT NULL DEFAULT '[]',
	source_task_id        TEXT REFERENCES tasks(id),
	source_interaction_id TEXT REFERENCES task_interactions(id),
	confidence            REAL NOT NULL DEFAULT 1.0,
	provenance_hash       TEXT NOT NULL,
	superseded_by         TEXT REFERENCES knowledge_entries(id),
	created_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
	updated_at            DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_knowledge_category ON knowledge_entries(category);
CREATE INDEX IF NOT EXISTS idx_knowledge_source_task ON knowledge_entries(source_task_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_superseded ON knowledge_entries(superseded_by);

CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
	id UNINDEXED,
	content,
	tags,
	tokenize='porter'
);

-- db_version triggers
CREATE TRIGGER IF NOT EXISTS knowledge_version_insert
AFTER INSERT ON knowledge_entries
BEGIN
	UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'db_version';
END;

CREATE TRIGGER IF NOT EXISTS knowledge_version_update
AFTER UPDATE ON knowledge_entries
BEGIN
	UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'db_version';
END;
`

const schemaV5 = `
CREATE TABLE IF NOT EXISTS explore_context (
	id         INTEGER PRIMARY KEY CHECK (id = 1),
	content    TEXT NOT NULL,
	hash       TEXT NOT NULL,
	updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER IF NOT EXISTS explore_context_version_insert
AFTER INSERT ON explore_context
BEGIN
	UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'db_version';
END;

CREATE TRIGGER IF NOT EXISTS explore_context_version_update
AFTER UPDATE ON explore_context
BEGIN
	UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'db_version';
END;
`
