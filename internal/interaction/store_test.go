package interaction

import (
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jasjeetmavi/orca/internal/state"
)

func setupDB(t *testing.T) *state.DB {
	t.Helper()
	db, err := state.Open(filepath.Join(t.TempDir(), "interaction-test.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func TestBeginFinishAndReadLog(t *testing.T) {
	db := setupDB(t)
	store := NewStore(db, filepath.Join(t.TempDir(), "logs"))

	taskID := "task-1"
	if _, err := db.Exec(`INSERT INTO tasks (id, title, status) VALUES (?, ?, 'running')`, taskID, "Task"); err != nil {
		t.Fatalf("insert task: %v", err)
	}

	w, err := store.Begin(&taskID, "run", "claude")
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	if err := w.WriteString("hello\nworld"); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := w.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	if err := store.Finish(w.ID(), "completed", WithDiff("d"), WithExitCode(0), WithDuration(1500*time.Millisecond), WithCost(10, 20, 0.12)); err != nil {
		t.Fatalf("finish: %v", err)
	}

	got, err := store.Get(w.ID())
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.Status != "completed" {
		t.Fatalf("status=%q want completed", got.Status)
	}
	if got.ExitCode == nil || *got.ExitCode != 0 {
		t.Fatalf("exit_code=%v want 0", got.ExitCode)
	}
	if got.DurationMS == nil || *got.DurationMS != 1500 {
		t.Fatalf("duration_ms=%v want 1500", got.DurationMS)
	}
	if got.EstimatedCost != 0.12 {
		t.Fatalf("estimated_cost=%v want 0.12", got.EstimatedCost)
	}

	logText, err := store.ReadLog(w.ID())
	if err != nil {
		t.Fatalf("read log: %v", err)
	}
	if !strings.Contains(logText, "hello") {
		t.Fatalf("log missing content: %q", logText)
	}
}

func TestIsRunning(t *testing.T) {
	db := setupDB(t)
	store := NewStore(db, filepath.Join(t.TempDir(), "logs"))

	taskID := "task-1"
	if _, err := db.Exec(`INSERT INTO tasks (id, title, status) VALUES (?, ?, 'running')`, taskID, "Task"); err != nil {
		t.Fatalf("insert task: %v", err)
	}

	w, err := store.Begin(&taskID, "plan", "claude")
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer w.Close()

	running, err := store.IsRunning(&taskID, "plan")
	if err != nil {
		t.Fatalf("is running: %v", err)
	}
	if !running {
		t.Fatal("expected running interaction")
	}

	other := "task-2"
	running, err = store.IsRunning(&other, "plan")
	if err != nil {
		t.Fatalf("is running other: %v", err)
	}
	if running {
		t.Fatal("did not expect running interaction for unrelated task")
	}

	running, err = store.IsRunning(nil, "plan")
	if err != nil {
		t.Fatalf("is running global: %v", err)
	}
	if !running {
		t.Fatal("expected running interaction globally")
	}
}

func TestSupersedeReviewPhase(t *testing.T) {
	db := setupDB(t)
	store := NewStore(db, filepath.Join(t.TempDir(), "logs"))

	taskID := "task-1"
	if _, err := db.Exec(`INSERT INTO tasks (id, title, status) VALUES (?, ?, 'review')`, taskID, "Task"); err != nil {
		t.Fatalf("insert task: %v", err)
	}

	w, err := store.Begin(&taskID, "review", "claude")
	if err != nil {
		t.Fatalf("begin review interaction: %v", err)
	}
	if err := w.Close(); err != nil {
		t.Fatalf("close review interaction writer: %v", err)
	}
	if err := store.Finish(w.ID(), "completed"); err != nil {
		t.Fatalf("finish review interaction: %v", err)
	}

	if err := store.SupersedeReviewPhase(taskID); err != nil {
		t.Fatalf("supersede review phase: %v", err)
	}

	got, err := store.Get(w.ID())
	if err != nil {
		t.Fatalf("get superseded interaction: %v", err)
	}
	if got.Status != "failed" {
		t.Fatalf("status=%q want failed", got.Status)
	}
	if got.Error == "" {
		t.Fatal("expected superseded interaction to include an error message")
	}
	if got.FinishedAt == nil {
		t.Fatal("expected superseded interaction to have finished_at")
	}
}
