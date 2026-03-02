package state

import (
	"database/sql"
	"fmt"
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
	assertTableExists(t, db.DB, "memory_entries")
	assertColumnExists(t, db.DB, "memory_entries", "source_type")
	assertColumnExists(t, db.DB, "memory_entries", "covered_at_commit")
	assertColumnExists(t, db.DB, "memory_entries", "stale")
	assertTableExists(t, db.DB, "memory_file_associations")
	assertTableExists(t, db.DB, "task_file_associations")
	assertTableExists(t, db.DB, "explore_context")
	assertVirtualTableExists(t, db.DB, "memory_fts")
	assertVirtualTableExists(t, db.DB, "tasks_fts")
	assertTriggerExists(t, db.DB, "explore_context_version_insert")
	assertTriggerExists(t, db.DB, "explore_context_version_update")
	assertTriggerExists(t, db.DB, "memory_file_associations_version_insert")
	assertTriggerExists(t, db.DB, "memory_file_associations_version_update")
	assertTriggerExists(t, db.DB, "memory_file_associations_version_delete")
	assertTriggerExists(t, db.DB, "task_file_associations_version_insert")
	assertTriggerExists(t, db.DB, "task_file_associations_version_update")
	assertTriggerExists(t, db.DB, "task_file_associations_version_delete")
	assertMetaValue(t, db.DB, "last_synced_commit", "")
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
	assertTableExists(t, db.DB, "memory_entries")
	assertColumnExists(t, db.DB, "memory_entries", "source_type")
	assertColumnExists(t, db.DB, "memory_entries", "covered_at_commit")
	assertColumnExists(t, db.DB, "memory_entries", "stale")
	assertTableExists(t, db.DB, "memory_file_associations")
	assertTableExists(t, db.DB, "task_file_associations")
	assertTableExists(t, db.DB, "explore_context")
	assertVirtualTableExists(t, db.DB, "memory_fts")
	assertVirtualTableExists(t, db.DB, "tasks_fts")
	assertTriggerExists(t, db.DB, "explore_context_version_insert")
	assertTriggerExists(t, db.DB, "explore_context_version_update")
	assertTriggerExists(t, db.DB, "memory_file_associations_version_insert")
	assertTriggerExists(t, db.DB, "memory_file_associations_version_update")
	assertTriggerExists(t, db.DB, "memory_file_associations_version_delete")
	assertTriggerExists(t, db.DB, "task_file_associations_version_insert")
	assertTriggerExists(t, db.DB, "task_file_associations_version_update")
	assertTriggerExists(t, db.DB, "task_file_associations_version_delete")
	assertMetaValue(t, db.DB, "last_synced_commit", "")
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
	assertTableExists(t, db.DB, "memory_entries")
	assertColumnExists(t, db.DB, "memory_entries", "source_type")
	assertColumnExists(t, db.DB, "memory_entries", "covered_at_commit")
	assertColumnExists(t, db.DB, "memory_entries", "stale")
	assertTableExists(t, db.DB, "memory_file_associations")
	assertTableExists(t, db.DB, "task_file_associations")
	assertTableExists(t, db.DB, "explore_context")
	assertVirtualTableExists(t, db.DB, "memory_fts")
	assertVirtualTableExists(t, db.DB, "tasks_fts")
	assertTriggerExists(t, db.DB, "explore_context_version_insert")
	assertTriggerExists(t, db.DB, "explore_context_version_update")
	assertTriggerExists(t, db.DB, "memory_file_associations_version_insert")
	assertTriggerExists(t, db.DB, "memory_file_associations_version_update")
	assertTriggerExists(t, db.DB, "memory_file_associations_version_delete")
	assertTriggerExists(t, db.DB, "task_file_associations_version_insert")
	assertTriggerExists(t, db.DB, "task_file_associations_version_update")
	assertTriggerExists(t, db.DB, "task_file_associations_version_delete")
	assertMetaValue(t, db.DB, "last_synced_commit", "")
	assertDBVersion(t, db, 0)
}

func TestOpenMigratesPreV6KnowledgeTablesToMemory(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "pre_v6.db")

	legacy, err := sql.Open("sqlite3", dbPath)
	if err != nil {
		t.Fatalf("open pre-v6 db: %v", err)
	}
	if _, err := legacy.Exec(preV6KnowledgeSchema); err != nil {
		legacy.Close()
		t.Fatalf("create pre-v6 schema: %v", err)
	}
	if err := legacy.Close(); err != nil {
		t.Fatalf("close pre-v6 db: %v", err)
	}

	db, err := Open(dbPath)
	if err != nil {
		t.Fatalf("open migrated pre-v6 db: %v", err)
	}
	t.Cleanup(func() { db.Close() })

	assertMigrationVersions(t, db.DB, len(migrations))
	assertTableDoesNotExist(t, db.DB, "knowledge_entries")
	assertTableExists(t, db.DB, "memory_entries")
	assertColumnExists(t, db.DB, "memory_entries", "source_type")
	assertColumnExists(t, db.DB, "memory_entries", "covered_at_commit")
	assertColumnExists(t, db.DB, "memory_entries", "stale")
	assertTableExists(t, db.DB, "memory_file_associations")
	assertTableExists(t, db.DB, "task_file_associations")
	assertVirtualTableExists(t, db.DB, "memory_fts")
	assertVirtualTableExists(t, db.DB, "tasks_fts")
	assertMetaValue(t, db.DB, "last_synced_commit", "")

	var content string
	var sourceType string
	if err := db.QueryRow(
		`SELECT content, source_type FROM memory_entries WHERE id = ?`,
		"mem-1",
	).Scan(&content, &sourceType); err != nil {
		t.Fatalf("select migrated memory entry: %v", err)
	}
	if content != "Prefer explicit retries" {
		t.Fatalf("content = %q, want %q", content, "Prefer explicit retries")
	}
	if sourceType != "retro" {
		t.Fatalf("source_type = %q, want %q", sourceType, "retro")
	}
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

func assertTableDoesNotExist(t *testing.T, db *sql.DB, table string) {
	t.Helper()
	var count int
	if err := db.QueryRow(
		`SELECT COUNT(1) FROM sqlite_master WHERE type = 'table' AND name = ?`,
		table,
	).Scan(&count); err != nil {
		t.Fatalf("check table %s: %v", table, err)
	}
	if count != 0 {
		t.Fatalf("table %s exists unexpectedly", table)
	}
}

func assertColumnExists(t *testing.T, db *sql.DB, table, column string) {
	t.Helper()
	var count int
	if err := db.QueryRow(
		fmt.Sprintf(`SELECT COUNT(*) FROM pragma_table_info(%q) WHERE name = ?`, table),
		column,
	).Scan(&count); err != nil {
		t.Fatalf("check column %s.%s: %v", table, column, err)
	}
	if count != 1 {
		t.Fatalf("column %s.%s missing", table, column)
	}
}

func assertMetaValue(t *testing.T, db *sql.DB, key, want string) {
	t.Helper()
	var got string
	if err := db.QueryRow(`SELECT value FROM meta WHERE key = ?`, key).Scan(&got); err != nil {
		t.Fatalf("load meta[%s]: %v", key, err)
	}
	if got != want {
		t.Fatalf("meta[%s] = %q, want %q", key, got, want)
	}
}

func assertVirtualTableExists(t *testing.T, db *sql.DB, table string) {
	t.Helper()
	var count int
	if err := db.QueryRow(
		`SELECT COUNT(1) FROM sqlite_master WHERE type = 'table' AND name = ? AND sql LIKE 'CREATE VIRTUAL TABLE%'`,
		table,
	).Scan(&count); err != nil {
		t.Fatalf("check virtual table %s: %v", table, err)
	}
	if count != 1 {
		t.Fatalf("virtual table %s missing", table)
	}
}

func assertTriggerExists(t *testing.T, db *sql.DB, trigger string) {
	t.Helper()
	var count int
	if err := db.QueryRow(
		`SELECT COUNT(1) FROM sqlite_master WHERE type = 'trigger' AND name = ?`,
		trigger,
	).Scan(&count); err != nil {
		t.Fatalf("check trigger %s: %v", trigger, err)
	}
	if count != 1 {
		t.Fatalf("trigger %s missing", trigger)
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

const preV6KnowledgeSchema = `
CREATE TABLE IF NOT EXISTS schema_migrations (
	version    INTEGER PRIMARY KEY,
	applied_at DATETIME NOT NULL
);

INSERT INTO schema_migrations(version, applied_at) VALUES
	(1, CURRENT_TIMESTAMP),
	(2, CURRENT_TIMESTAMP),
	(3, CURRENT_TIMESTAMP),
	(4, CURRENT_TIMESTAMP),
	(5, CURRENT_TIMESTAMP);

CREATE TABLE IF NOT EXISTS tasks (
	id TEXT PRIMARY KEY,
	title TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_interactions (
	id TEXT PRIMARY KEY,
	task_id TEXT REFERENCES tasks(id)
);

CREATE TABLE IF NOT EXISTS meta (
	key   TEXT PRIMARY KEY,
	value TEXT NOT NULL
);

INSERT OR IGNORE INTO meta (key, value) VALUES ('db_version', '0');

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

CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
	id UNINDEXED,
	content,
	tags,
	tokenize='porter'
);

INSERT INTO knowledge_entries (
	id, content, category, tags, confidence, provenance_hash
) VALUES (
	'mem-1', 'Prefer explicit retries', 'pattern', '["retry","network"]', 0.9, 'hash-mem-1'
);

INSERT INTO knowledge_fts (id, content, tags)
VALUES ('mem-1', 'Prefer explicit retries', '["retry","network"]');
`
