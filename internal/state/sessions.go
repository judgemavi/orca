package state

import (
	"database/sql"
	"errors"
	"os"
	"syscall"
	"time"
)

// SessionRow is a persisted PTY session row.
type SessionRow struct {
	ID        string
	Type      string
	Tool      string
	TaskID    string
	PID       int
	Dir       string
	Cols      int
	Rows      int
	Status    string
	ExitCode  int
	CreatedAt time.Time
	ExitedAt  *time.Time
}

// InsertSession inserts a running PTY session row.
func (db *DB) InsertSession(id, typ, tool, taskID string, pid int, dir string, cols, rows int) error {
	_, err := db.Exec(
		`INSERT INTO sessions (id, type, tool, task_id, pid, working_dir, cols, rows) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		id, typ, tool, taskID, pid, dir, cols, rows,
	)
	return err
}

// MarkSessionExited marks a session as exited with an exit code.
func (db *DB) MarkSessionExited(id string, exitCode int) error {
	_, err := db.Exec(
		`UPDATE sessions SET status = 'exited', exit_code = ?, exited_at = CURRENT_TIMESTAMP WHERE id = ?`,
		exitCode, id,
	)
	return err
}

// ListActiveSessions returns sessions currently marked as running.
func (db *DB) ListActiveSessions() ([]SessionRow, error) {
	rows, err := db.Query(`
		SELECT id, type, tool, task_id, pid, working_dir, cols, rows,
		       status, exit_code, created_at, exited_at
		FROM sessions
		WHERE status = 'running'
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []SessionRow
	for rows.Next() {
		var (
			r      SessionRow
			taskID sql.NullString
			dir    sql.NullString
			exited sql.NullTime
		)
		if err := rows.Scan(
			&r.ID,
			&r.Type,
			&r.Tool,
			&taskID,
			&r.PID,
			&dir,
			&r.Cols,
			&r.Rows,
			&r.Status,
			&r.ExitCode,
			&r.CreatedAt,
			&exited,
		); err != nil {
			return nil, err
		}
		if taskID.Valid {
			r.TaskID = taskID.String
		}
		if dir.Valid {
			r.Dir = dir.String
		}
		if exited.Valid {
			t := exited.Time
			r.ExitedAt = &t
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// MarkStaleSessions marks running sessions with dead PIDs as exited.
func (db *DB) MarkStaleSessions() (int, error) {
	sessions, err := db.ListActiveSessions()
	if err != nil {
		return 0, err
	}

	marked := 0
	for _, sess := range sessions {
		if isProcessAlive(sess.PID) {
			continue
		}
		if err := db.MarkSessionExited(sess.ID, -1); err != nil {
			return marked, err
		}
		marked++
	}

	return marked, nil
}

func isProcessAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	process, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	err = process.Signal(syscall.Signal(0))
	if err == nil {
		return true
	}
	return errors.Is(err, syscall.EPERM)
}
