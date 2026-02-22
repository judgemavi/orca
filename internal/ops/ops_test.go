package ops

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jasjeetmavi/orca/internal/state"
)

func testDB(t *testing.T) *state.DB {
	t.Helper()
	db, err := state.Open(filepath.Join(t.TempDir(), "ops-test.db"))
	if err != nil {
		t.Fatalf("open test db: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func TestCreateGetCompleteFail(t *testing.T) {
	store := NewStore(testDB(t))
	id := uuid.New().String()

	if err := store.Create(Operation{
		ID:       id,
		Type:     "plan_generate",
		TargetID: "task-123",
	}); err != nil {
		t.Fatalf("create: %v", err)
	}

	created, err := store.Get(id)
	if err != nil {
		t.Fatalf("get after create: %v", err)
	}
	if created.Status != "running" {
		t.Fatalf("status = %q, want running", created.Status)
	}

	if err := store.Complete(id, `{"plan":"ok"}`); err != nil {
		t.Fatalf("complete: %v", err)
	}
	completed, err := store.Get(id)
	if err != nil {
		t.Fatalf("get after complete: %v", err)
	}
	if completed.Status != "completed" {
		t.Fatalf("status = %q, want completed", completed.Status)
	}
	if completed.Result != `{"plan":"ok"}` {
		t.Fatalf("result = %q, want json blob", completed.Result)
	}

	if err := store.Fail(id, "forced failure"); err != nil {
		t.Fatalf("fail: %v", err)
	}
	failed, err := store.Get(id)
	if err != nil {
		t.Fatalf("get after fail: %v", err)
	}
	if failed.Status != "failed" {
		t.Fatalf("status = %q, want failed", failed.Status)
	}
	if failed.Error != "forced failure" {
		t.Fatalf("error = %q, want forced failure", failed.Error)
	}
}

func TestGetByTargetAndListRunning(t *testing.T) {
	store := NewStore(testDB(t))

	id1 := uuid.New().String()
	id2 := uuid.New().String()

	if err := store.Create(Operation{ID: id1, Type: "plan_generate", TargetID: "task-a"}); err != nil {
		t.Fatalf("create id1: %v", err)
	}
	if err := store.Create(Operation{ID: id2, Type: "explore", TargetID: ""}); err != nil {
		t.Fatalf("create id2: %v", err)
	}

	op, err := store.GetByTarget("task-a", "plan_generate")
	if err != nil {
		t.Fatalf("get by target: %v", err)
	}
	if op.ID != id1 {
		t.Fatalf("id = %q, want %q", op.ID, id1)
	}

	running, err := store.ListRunning()
	if err != nil {
		t.Fatalf("list running: %v", err)
	}
	if len(running) != 2 {
		t.Fatalf("len(running) = %d, want 2", len(running))
	}

	if err := store.Complete(id1, "done"); err != nil {
		t.Fatalf("complete id1: %v", err)
	}

	_, err = store.GetByTarget("task-a", "plan_generate")
	if err == nil {
		t.Fatal("expected error for no running operation by target")
	}
}

func TestListByTypeAndMarkStaleAsFailed(t *testing.T) {
	store := NewStore(testDB(t))

	runID := uuid.New().String()
	doneID := uuid.New().String()
	otherID := uuid.New().String()

	if err := store.Create(Operation{ID: runID, Type: "merge", TargetID: "task-1"}); err != nil {
		t.Fatalf("create run: %v", err)
	}
	if err := store.Create(Operation{ID: doneID, Type: "merge", TargetID: "task-2"}); err != nil {
		t.Fatalf("create done: %v", err)
	}
	if err := store.Complete(doneID, "{}"); err != nil {
		t.Fatalf("complete done: %v", err)
	}
	if err := store.Create(Operation{ID: otherID, Type: "explore", TargetID: ""}); err != nil {
		t.Fatalf("create other: %v", err)
	}

	byType, err := store.ListByType("merge")
	if err != nil {
		t.Fatalf("list by type: %v", err)
	}
	if len(byType) != 2 {
		t.Fatalf("len(byType) = %d, want 2", len(byType))
	}

	time.Sleep(10 * time.Millisecond)
	if err := store.MarkStaleAsFailed(); err != nil {
		t.Fatalf("mark stale: %v", err)
	}

	runOp, err := store.Get(runID)
	if err != nil {
		t.Fatalf("get run: %v", err)
	}
	if runOp.Status != "failed" {
		t.Fatalf("status = %q, want failed", runOp.Status)
	}
	if runOp.Error == "" {
		t.Fatal("expected non-empty stale failure error")
	}

	doneOp, err := store.Get(doneID)
	if err != nil {
		t.Fatalf("get done: %v", err)
	}
	if doneOp.Status != "completed" {
		t.Fatalf("status = %q, want completed", doneOp.Status)
	}
}
