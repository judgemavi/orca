package state

import (
	"database/sql"
	"path/filepath"
	"testing"

	_ "github.com/mattn/go-sqlite3"
)

func TestOpenAppliesVersionedMigrationsAndIsIdempotent(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "state.db")

	db, err := Open(dbPath)
	if err != nil {
		t.Fatalf("open fresh db: %v", err)
	}

	assertMigrationVersions(t, db.DB, len(migrations))
	assertTaskColumns(t, db.DB, "plan", "session_id")
	assertInteractionColumns(t, db.DB, "quality_json", "log_path", "phase", "status")
	assertReviewColumns(t, db.DB, "interaction_id")
	assertTableExists(t, db.DB, "config")
	assertDBVersion(t, db, 0)

	if err := db.Close(); err != nil {
		t.Fatalf("close db: %v", err)
	}

	db, err = Open(dbPath)
	if err != nil {
		t.Fatalf("re-open db: %v", err)
	}
	t.Cleanup(func() { db.Close() })

	assertMigrationVersions(t, db.DB, len(migrations))
	assertTaskColumns(t, db.DB, "plan", "session_id")
	assertInteractionColumns(t, db.DB, "quality_json", "log_path", "phase", "status")
	assertReviewColumns(t, db.DB, "interaction_id")
	assertTableExists(t, db.DB, "config")
	assertDBVersion(t, db, 0)
}

func TestOpenMigratesLegacyUnversionedDB(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "legacy.db")

	legacy, err := sql.Open("sqlite3", dbPath)
	if err != nil {
		t.Fatalf("open legacy db: %v", err)
	}
	if _, err := legacy.Exec(legacySchema); err != nil {
		legacy.Close()
		t.Fatalf("create legacy schema: %v", err)
	}
	if err := legacy.Close(); err != nil {
		t.Fatalf("close legacy db: %v", err)
	}

	db, err := Open(dbPath)
	if err != nil {
		t.Fatalf("open migrated legacy db: %v", err)
	}
	t.Cleanup(func() { db.Close() })

	assertMigrationVersions(t, db.DB, len(migrations))
	assertTaskColumns(t, db.DB, "plan", "session_id")
	assertInteractionColumns(t, db.DB, "quality_json", "log_path", "phase", "status")
	assertReviewColumns(t, db.DB, "interaction_id")
	assertTableExists(t, db.DB, "config")
	assertDBVersion(t, db, 0)
}

func TestDBVersionIncrementsOnTaskMutations(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "mutations.db")

	db, err := Open(dbPath)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { db.Close() })

	assertDBVersion(t, db, 0)

	if _, err := db.Exec(`INSERT INTO tasks (id, title) VALUES (?, ?)`, "t1", "Task 1"); err != nil {
		t.Fatalf("insert task: %v", err)
	}
	assertDBVersion(t, db, 1)

	if _, err := db.Exec(`UPDATE tasks SET title = ? WHERE id = ?`, "Task 1 updated", "t1"); err != nil {
		t.Fatalf("update task: %v", err)
	}
	assertDBVersion(t, db, 2)

	if _, err := db.Exec(`DELETE FROM tasks WHERE id = ?`, "t1"); err != nil {
		t.Fatalf("delete task: %v", err)
	}
	assertDBVersion(t, db, 3)
}

func assertMigrationVersions(t *testing.T, db *sql.DB, want int) {
	t.Helper()

	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM schema_migrations`).Scan(&count); err != nil {
		t.Fatalf("count schema_migrations: %v", err)
	}
	if count != want {
		t.Fatalf("migration count = %d, want %d", count, want)
	}

	var maxVersion int
	if err := db.QueryRow(`SELECT COALESCE(MAX(version), 0) FROM schema_migrations`).Scan(&maxVersion); err != nil {
		t.Fatalf("max schema_migrations version: %v", err)
	}
	if maxVersion != want {
		t.Fatalf("max migration version = %d, want %d", maxVersion, want)
	}
}

func assertTaskColumns(t *testing.T, db *sql.DB, columns ...string) {
	t.Helper()
	for _, column := range columns {
		var count int
		if err := db.QueryRow(
			`SELECT COUNT(*) FROM pragma_table_info('tasks') WHERE name = ?`,
			column,
		).Scan(&count); err != nil {
			t.Fatalf("check tasks.%s column: %v", column, err)
		}
		if count != 1 {
			t.Fatalf("tasks.%s missing", column)
		}
	}
}

func assertInteractionColumns(t *testing.T, db *sql.DB, columns ...string) {
	t.Helper()
	for _, column := range columns {
		var count int
		if err := db.QueryRow(
			`SELECT COUNT(*) FROM pragma_table_info('task_interactions') WHERE name = ?`,
			column,
		).Scan(&count); err != nil {
			t.Fatalf("check task_interactions.%s column: %v", column, err)
		}
		if count != 1 {
			t.Fatalf("task_interactions.%s missing", column)
		}
	}
}

func assertReviewColumns(t *testing.T, db *sql.DB, columns ...string) {
	t.Helper()
	for _, column := range columns {
		var count int
		if err := db.QueryRow(
			`SELECT COUNT(*) FROM pragma_table_info('task_reviews') WHERE name = ?`,
			column,
		).Scan(&count); err != nil {
			t.Fatalf("check task_reviews.%s column: %v", column, err)
		}
		if count != 1 {
			t.Fatalf("task_reviews.%s missing", column)
		}
	}
}

func assertDBVersion(t *testing.T, db *DB, want int64) {
	t.Helper()

	got, err := db.DBVersion()
	if err != nil {
		t.Fatalf("get db_version: %v", err)
	}
	if got != want {
		t.Fatalf("db_version = %d, want %d", got, want)
	}
}

func assertTableExists(t *testing.T, db *sql.DB, table string) {
	t.Helper()
	var count int
	if err := db.QueryRow(
		`SELECT COUNT(1) FROM sqlite_master WHERE type = 'table' AND name = ?`,
		table,
	).Scan(&count); err != nil {
		t.Fatalf("check table %s: %v", table, err)
	}
	if count != 1 {
		t.Fatalf("table %s missing", table)
	}
}

const legacySchema = `
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
