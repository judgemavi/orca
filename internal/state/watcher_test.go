package state

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
	"time"

	_ "github.com/mattn/go-sqlite3"
)

func TestWatcherDetectsCrossConnectionTaskMutations(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "watcher.db")

	db, err := Open(dbPath)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { db.Close() })

	if _, err := db.Exec(`INSERT INTO tasks (id, title) VALUES (?, ?)`, "existing", "Existing task"); err != nil {
		t.Fatalf("seed existing task: %v", err)
	}

	changeCh := make(chan []TaskChange, 16)
	watcher := NewWatcher(db, WatcherCallbacks{
		OnTaskChange: func(changes []TaskChange) {
			copied := make([]TaskChange, len(changes))
			copy(copied, changes)
			changeCh <- copied
		},
	}, WatcherOpts{Interval: 50 * time.Millisecond})

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		watcher.Run(ctx)
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(1 * time.Second):
			t.Fatalf("watcher did not stop after cancellation")
		}
	})

	select {
	case got := <-changeCh:
		t.Fatalf("unexpected startup callback: %+v", got)
	case <-time.After(300 * time.Millisecond):
	}

	raw, err := sql.Open("sqlite3", dbPath)
	if err != nil {
		t.Fatalf("open second connection: %v", err)
	}
	defer raw.Close()

	if _, err := raw.Exec(`INSERT INTO tasks (id, title) VALUES (?, ?)`, "t-create", "Created"); err != nil {
		t.Fatalf("insert via second connection: %v", err)
	}
	waitForChange(t, changeCh, TaskChange{Type: ChangeCreated, TaskID: "t-create"}, 1500*time.Millisecond)

	if _, err := raw.Exec(
		`UPDATE tasks SET title = ?, updated_at = datetime(updated_at, '+1 second') WHERE id = ?`,
		"Updated",
		"t-create",
	); err != nil {
		t.Fatalf("update via second connection: %v", err)
	}
	waitForChange(t, changeCh, TaskChange{Type: ChangeUpdated, TaskID: "t-create"}, 1500*time.Millisecond)

	if _, err := raw.Exec(`DELETE FROM tasks WHERE id = ?`, "t-create"); err != nil {
		t.Fatalf("delete via second connection: %v", err)
	}
	waitForChange(t, changeCh, TaskChange{Type: ChangeDeleted, TaskID: "t-create"}, 1500*time.Millisecond)
}

func TestWatcherRunStopsOnContextCancel(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "watcher-cancel.db")

	db, err := Open(dbPath)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { db.Close() })

	watcher := NewWatcher(db, WatcherCallbacks{}, WatcherOpts{Interval: 25 * time.Millisecond})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		watcher.Run(ctx)
	}()

	cancel()
	select {
	case <-done:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("watcher did not stop after context cancellation")
	}
}

func TestWatcherDetectsCrossConnectionStatusTableMutations(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "watcher-status.db")

	db, err := Open(dbPath)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { db.Close() })

	interactionCh := make(chan []InteractionChange, 16)
	sessionCh := make(chan []SessionChange, 16)
	watcher := NewWatcher(db, WatcherCallbacks{
		OnInteractionChange: func(changes []InteractionChange) {
			copied := make([]InteractionChange, len(changes))
			copy(copied, changes)
			interactionCh <- copied
		},
		OnSessionChange: func(changes []SessionChange) {
			copied := make([]SessionChange, len(changes))
			copy(copied, changes)
			sessionCh <- copied
		},
	}, WatcherOpts{Interval: 50 * time.Millisecond})

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		watcher.Run(ctx)
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(1 * time.Second):
			t.Fatalf("watcher did not stop after cancellation")
		}
	})

	assertNoStatusChangeOnStartup(t, interactionCh, sessionCh)

	raw, err := sql.Open("sqlite3", dbPath)
	if err != nil {
		t.Fatalf("open second connection: %v", err)
	}
	defer raw.Close()

	if _, err := raw.Exec(
		`INSERT INTO task_interactions (id, phase, tool, log_path, status) VALUES (?, ?, ?, ?, ?)`,
		"op-1", "run", "claude", ".orca/interactions/_project/run-1-op-1.log", "running",
	); err != nil {
		t.Fatalf("insert operation via second connection: %v", err)
	}
	waitForInteractionChange(t, interactionCh, InteractionChange{Type: ChangeCreated, InteractionID: "op-1"}, 1500*time.Millisecond)

	if _, err := raw.Exec(`UPDATE task_interactions SET status = ? WHERE id = ?`, "completed", "op-1"); err != nil {
		t.Fatalf("update operation via second connection: %v", err)
	}
	waitForInteractionChange(t, interactionCh, InteractionChange{Type: ChangeUpdated, InteractionID: "op-1"}, 1500*time.Millisecond)

	if _, err := raw.Exec(
		`INSERT INTO sessions (id, type, tool, pid, status) VALUES (?, ?, ?, ?, ?)`,
		"sess-1", "worker", "claude", 99999, "running",
	); err != nil {
		t.Fatalf("insert session via second connection: %v", err)
	}
	waitForSessionChange(t, sessionCh, SessionChange{Type: ChangeCreated, SessionID: "sess-1"}, 1500*time.Millisecond)

	if _, err := raw.Exec(
		`UPDATE sessions SET status = ?, exit_code = ? WHERE id = ?`,
		"exited", 0, "sess-1",
	); err != nil {
		t.Fatalf("update session via second connection: %v", err)
	}
	waitForSessionChange(t, sessionCh, SessionChange{Type: ChangeUpdated, SessionID: "sess-1"}, 1500*time.Millisecond)
}

func waitForChange(t *testing.T, changeCh <-chan []TaskChange, want TaskChange, timeout time.Duration) {
	t.Helper()

	timer := time.NewTimer(timeout)
	defer timer.Stop()

	for {
		select {
		case batch := <-changeCh:
			for _, got := range batch {
				if got == want {
					return
				}
			}
		case <-timer.C:
			t.Fatalf("timed out waiting for change %+v", want)
		}
	}
}

func waitForInteractionChange(t *testing.T, changeCh <-chan []InteractionChange, want InteractionChange, timeout time.Duration) {
	t.Helper()

	timer := time.NewTimer(timeout)
	defer timer.Stop()

	for {
		select {
		case batch := <-changeCh:
			for _, got := range batch {
				if got == want {
					return
				}
			}
		case <-timer.C:
			t.Fatalf("timed out waiting for change %+v", want)
		}
	}
}

func waitForSessionChange(t *testing.T, changeCh <-chan []SessionChange, want SessionChange, timeout time.Duration) {
	t.Helper()

	timer := time.NewTimer(timeout)
	defer timer.Stop()

	for {
		select {
		case batch := <-changeCh:
			for _, got := range batch {
				if got == want {
					return
				}
			}
		case <-timer.C:
			t.Fatalf("timed out waiting for change %+v", want)
		}
	}
}

func assertNoStatusChangeOnStartup(
	t *testing.T,
	interactionCh <-chan []InteractionChange,
	sessionCh <-chan []SessionChange,
) {
	t.Helper()

	timer := time.NewTimer(300 * time.Millisecond)
	defer timer.Stop()

	select {
	case got := <-interactionCh:
		t.Fatalf("unexpected startup interaction callback: %+v", got)
	case got := <-sessionCh:
		t.Fatalf("unexpected startup session callback: %+v", got)
	case <-timer.C:
	}
}
