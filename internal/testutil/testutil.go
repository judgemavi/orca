package testutil

import (
	"path/filepath"
	"testing"

	"github.com/jasjeetmavi/orca/internal/state"
)

// DB opens a temp SQLite DB for testing and registers cleanup.
func DB(t *testing.T) *state.DB {
	t.Helper()

	db, err := state.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("open test db: %v", err)
	}
	t.Cleanup(func() { db.Close() })

	return db
}
