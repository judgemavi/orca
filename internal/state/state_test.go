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
	assertTaskColumns(t, db.DB, "model", "plan", "session_id", "phase_config")
	assertArtifactColumns(t, db.DB, "quality_json")
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
	assertTaskColumns(t, db.DB, "model", "plan", "session_id", "phase_config")
	assertArtifactColumns(t, db.DB, "quality_json")
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
	assertTaskColumns(t, db.DB, "model", "plan", "session_id", "phase_config")
	assertArtifactColumns(t, db.DB, "quality_json")
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

func TestMigrationV7(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "v6.db")

	legacy, err := sql.Open("sqlite3", dbPath)
	if err != nil {
		t.Fatalf("open legacy db: %v", err)
	}
	t.Cleanup(func() { legacy.Close() })

	if _, err := legacy.Exec(legacySchema); err != nil {
		t.Fatalf("create legacy schema: %v", err)
	}
	if _, err := legacy.Exec(`
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version    INTEGER PRIMARY KEY,
			applied_at DATETIME NOT NULL
		)
	`); err != nil {
		t.Fatalf("create schema_migrations: %v", err)
	}
	for i := 1; i <= 6; i++ {
		if _, err := legacy.Exec(
			`INSERT INTO schema_migrations(version, applied_at) VALUES (?, CURRENT_TIMESTAMP)`,
			i,
		); err != nil {
			t.Fatalf("seed migration version %d: %v", i, err)
		}
	}

	if _, err := legacy.Exec(
		`INSERT INTO tasks (id, title, assigned_tool, status) VALUES (?, ?, ?, ?)`,
		"task-v6-1", "Legacy task", "codex", "pending",
	); err != nil {
		t.Fatalf("insert legacy task: %v", err)
	}
	if err := legacy.Close(); err != nil {
		t.Fatalf("close legacy db: %v", err)
	}

	db, err := Open(dbPath)
	if err != nil {
		t.Fatalf("open migrated db: %v", err)
	}
	t.Cleanup(func() { db.Close() })

	assertTaskColumns(t, db.DB, "phase_config")
	assertArtifactColumns(t, db.DB, "quality_json")
	assertMigrationVersions(t, db.DB, len(migrations))

	var phaseConfig sql.NullString
	var assignedTool sql.NullString
	if err := db.QueryRow(
		`SELECT phase_config, assigned_tool FROM tasks WHERE id = ?`,
		"task-v6-1",
	).Scan(&phaseConfig, &assignedTool); err != nil {
		t.Fatalf("load migrated task row: %v", err)
	}
	if phaseConfig.Valid {
		t.Fatalf("phase_config valid = true (%q), want false (NULL)", phaseConfig.String)
	}
	if !assignedTool.Valid || assignedTool.String != "codex" {
		t.Fatalf("assigned_tool = %#v, want %q", assignedTool, "codex")
	}
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

func assertArtifactColumns(t *testing.T, db *sql.DB, columns ...string) {
	t.Helper()
	for _, column := range columns {
		var count int
		if err := db.QueryRow(
			`SELECT COUNT(*) FROM pragma_table_info('artifacts') WHERE name = ?`,
			column,
		).Scan(&count); err != nil {
			t.Fatalf("check artifacts.%s column: %v", column, err)
		}
		if count != 1 {
			t.Fatalf("artifacts.%s missing", column)
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

const legacySchema = `
CREATE TABLE IF NOT EXISTS tasks (
	id          TEXT PRIMARY KEY,
	title       TEXT NOT NULL,
	description TEXT,
	prompt      TEXT,
	model       TEXT,
	plan        TEXT,
	parent_id   TEXT REFERENCES tasks(id),
	status      TEXT NOT NULL DEFAULT 'pending',
	assigned_tool TEXT,
	sprint_id   TEXT,
	created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
	updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
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

CREATE TABLE IF NOT EXISTS sprints (
	id           TEXT PRIMARY KEY,
	status       TEXT NOT NULL DEFAULT 'planning',
	created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
	completed_at DATETIME
);

CREATE TABLE IF NOT EXISTS artifacts (
	id          TEXT PRIMARY KEY,
	task_id     TEXT NOT NULL REFERENCES tasks(id),
	sprint_id   TEXT NOT NULL REFERENCES sprints(id),
	diff        TEXT,
	stdout      TEXT,
	stderr      TEXT,
	exit_code   INTEGER,
	duration_ms INTEGER,
	created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS costs (
	id             TEXT PRIMARY KEY,
	sprint_id      TEXT REFERENCES sprints(id),
	task_id        TEXT REFERENCES tasks(id),
	tool           TEXT NOT NULL,
	input_tokens   INTEGER DEFAULT 0,
	output_tokens  INTEGER DEFAULT 0,
	estimated_cost REAL DEFAULT 0.0,
	created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS operations (
	id         TEXT PRIMARY KEY,
	type       TEXT NOT NULL,
	target_id  TEXT NOT NULL,
	status     TEXT NOT NULL DEFAULT 'running',
	result     TEXT,
	error      TEXT,
	created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
	updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

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
`
