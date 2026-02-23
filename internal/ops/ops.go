// Package ops persists long-running operation state.
package ops

import (
	"database/sql"
	"fmt"
	"time"

	"github.com/jasjeetmavi/orca/internal/nullable"
	"github.com/jasjeetmavi/orca/internal/state"
)

// Operation captures lifecycle state for an async/long-running server action.
type Operation struct {
	ID        string    `json:"id"`
	Type      string    `json:"type"`
	TargetID  string    `json:"target_id"`
	Status    string    `json:"status"`
	Result    string    `json:"result,omitempty"`
	Error     string    `json:"error,omitempty"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type Store struct {
	db *state.DB
}

func NewStore(db *state.DB) *Store {
	return &Store{db: db}
}

func (s *Store) Create(op Operation) error {
	if op.ID == "" {
		return fmt.Errorf("operation id required")
	}
	if op.Type == "" {
		return fmt.Errorf("operation type required")
	}
	if op.Status == "" {
		op.Status = "running"
	}

	now := time.Now().UTC()
	_, err := s.db.Exec(
		`INSERT INTO operations (id, type, target_id, status, result, error, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		op.ID, op.Type, op.TargetID, op.Status, nullable.IfEmpty(op.Result), nullable.IfEmpty(op.Error), now, now,
	)
	if err != nil {
		return fmt.Errorf("create operation: %w", err)
	}
	return nil
}

func (s *Store) Complete(id string, result string) error {
	res, err := s.db.Exec(
		`UPDATE operations
		 SET status = 'completed', result = ?, error = NULL, updated_at = ?
		 WHERE id = ?`,
		nullable.IfEmpty(result), time.Now().UTC(), id,
	)
	if err != nil {
		return fmt.Errorf("complete operation: %w", err)
	}
	return ensureRowsAffected(res, id)
}

func (s *Store) Fail(id string, errMsg string) error {
	res, err := s.db.Exec(
		`UPDATE operations
		 SET status = 'failed', error = ?, updated_at = ?
		 WHERE id = ?`,
		errMsg, time.Now().UTC(), id,
	)
	if err != nil {
		return fmt.Errorf("fail operation: %w", err)
	}
	return ensureRowsAffected(res, id)
}

func (s *Store) Get(id string) (*Operation, error) {
	row := s.db.QueryRow(
		`SELECT id, type, target_id, status, result, error, created_at, updated_at
		 FROM operations WHERE id = ?`,
		id,
	)
	op, err := scanOperation(row.Scan)
	if err != nil {
		return nil, fmt.Errorf("get operation: %w", err)
	}
	return op, nil
}

// GetByTarget returns a currently running operation for a target/type, if any.
func (s *Store) GetByTarget(targetID, opType string) (*Operation, error) {
	row := s.db.QueryRow(
		`SELECT id, type, target_id, status, result, error, created_at, updated_at
		 FROM operations
		 WHERE target_id = ? AND type = ? AND status = 'running'
		 ORDER BY created_at DESC
		 LIMIT 1`,
		targetID, opType,
	)
	op, err := scanOperation(row.Scan)
	if err != nil {
		return nil, fmt.Errorf("get operation by target: %w", err)
	}
	return op, nil
}

func (s *Store) ListRunning() ([]Operation, error) {
	rows, err := s.db.Query(
		`SELECT id, type, target_id, status, result, error, created_at, updated_at
		 FROM operations
		 WHERE status = 'running'
		 ORDER BY created_at DESC`,
	)
	if err != nil {
		return nil, fmt.Errorf("list running operations: %w", err)
	}
	defer rows.Close()
	return readOperations(rows)
}

func (s *Store) ListByType(opType string) ([]Operation, error) {
	rows, err := s.db.Query(
		`SELECT id, type, target_id, status, result, error, created_at, updated_at
		 FROM operations
		 WHERE type = ?
		 ORDER BY created_at DESC`,
		opType,
	)
	if err != nil {
		return nil, fmt.Errorf("list operations by type: %w", err)
	}
	defer rows.Close()
	return readOperations(rows)
}

func (s *Store) MarkStaleAsFailed() error {
	_, err := s.db.Exec(
		`UPDATE operations
		 SET status = 'failed', error = ?, updated_at = ?
		 WHERE status = 'running'`,
		"operation interrupted: server restarted",
		time.Now().UTC(),
	)
	if err != nil {
		return fmt.Errorf("mark stale operations failed: %w", err)
	}
	return nil
}

func scanOperation(scan func(dest ...interface{}) error) (*Operation, error) {
	var op Operation
	var result sql.NullString
	var errText sql.NullString
	if err := scan(
		&op.ID,
		&op.Type,
		&op.TargetID,
		&op.Status,
		&result,
		&errText,
		&op.CreatedAt,
		&op.UpdatedAt,
	); err != nil {
		return nil, err
	}
	op.Result = nullable.ToString(result)
	op.Error = nullable.ToString(errText)
	return &op, nil
}

func readOperations(rows *sql.Rows) ([]Operation, error) {
	var ops []Operation
	for rows.Next() {
		op, err := scanOperation(rows.Scan)
		if err != nil {
			return nil, fmt.Errorf("scan operation: %w", err)
		}
		ops = append(ops, *op)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate operations: %w", err)
	}
	return ops, nil
}

func ensureRowsAffected(res sql.Result, id string) error {
	n, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("rows affected: %w", err)
	}
	if n == 0 {
		return fmt.Errorf("operation %s not found", id)
	}
	return nil
}
