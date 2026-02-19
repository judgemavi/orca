// Package state manages SQLite persistence for tasks, sprints, artifacts, and exploration context.
package state

import (
	"database/sql"
	"fmt"

	_ "github.com/mattn/go-sqlite3"
)

// DB wraps a SQLite connection with Pod-specific operations.
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
	_, err := db.Exec(schema)
	return err
}

const schema = `
CREATE TABLE IF NOT EXISTS tasks (
	id          TEXT PRIMARY KEY,
	title       TEXT NOT NULL,
	description TEXT,
	prompt      TEXT,
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
`
