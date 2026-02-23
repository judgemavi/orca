package ops

import (
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jasjeetmavi/orca/internal/state"
)

// WithOperation tracks fn as an operation, marking completed on success or failed on error.
func WithOperation(db *state.DB, opType, targetID string, fn func() error) error {
	if err := ensureOperationsTable(db); err != nil {
		return fmt.Errorf("ensure operations table: %w", err)
	}

	store := NewStore(db)
	opID := uuid.New().String()
	if err := store.Create(Operation{
		ID:       opID,
		Type:     opType,
		TargetID: targetID,
		Status:   "running",
	}); err != nil {
		return fmt.Errorf("create operation: %w", err)
	}

	if err := fn(); err != nil {
		if failErr := store.Fail(opID, err.Error()); failErr != nil {
			return errors.Join(err, fmt.Errorf("fail operation: %w", failErr))
		}
		return err
	}

	if err := store.Complete(opID, ""); err != nil {
		return fmt.Errorf("complete operation: %w", err)
	}
	return nil
}

func ensureOperationsTable(db *state.DB) error {
	_, err := db.Exec(`
CREATE TABLE IF NOT EXISTS operations (
	id TEXT PRIMARY KEY,
	type TEXT NOT NULL,
	target_id TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'running',
	result TEXT,
	error TEXT,
	created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
	updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`)
	return err
}
