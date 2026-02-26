package executor

import (
	"os/exec"
	"testing"

	"github.com/jasjeetmavi/orca/internal/task"
	"github.com/jasjeetmavi/orca/internal/testutil"
)

func TestStopTaskReturnsErrorForNonRunningTask(t *testing.T) {
	e := &Executor{
		running:  make(map[string]*exec.Cmd),
		sessions: make(map[string]string),
	}

	err := e.StopTask("missing-task")
	if err == nil {
		t.Fatal("expected error for non-running task")
	}
	if err.Error() != "task not running" {
		t.Fatalf("error = %q, want %q", err.Error(), "task not running")
	}
}

func TestResumeTaskRequiresStoppedStatus(t *testing.T) {
	db := testutil.DB(t)
	store := task.NewStore(db)
	e := &Executor{taskStore: store}

	tk, err := store.Create("t1", "desc", "")
	if err != nil {
		t.Fatalf("create task: %v", err)
	}
	if err := store.Update(tk.ID, map[string]interface{}{"status": "running", "session_id": "sess-123"}); err != nil {
		t.Fatalf("set running status and session: %v", err)
	}

	_, err = e.ResumeTask(tk.ID)
	if err == nil {
		t.Fatal("expected error for non-stopped task")
	}
	if err.Error() != `task `+tk.ID+` is "running", only stopped tasks can be resumed` {
		t.Fatalf("error = %q", err.Error())
	}
}

func TestResumeTaskRequiresSessionID(t *testing.T) {
	db := testutil.DB(t)
	store := task.NewStore(db)
	e := &Executor{taskStore: store}

	tk, err := store.Create("t1", "desc", "")
	if err != nil {
		t.Fatalf("create task: %v", err)
	}
	if err := store.Update(tk.ID, map[string]interface{}{"status": "stopped"}); err != nil {
		t.Fatalf("set stopped status: %v", err)
	}

	_, err = e.ResumeTask(tk.ID)
	if err == nil {
		t.Fatal("expected error for missing session_id")
	}
	if err.Error() != "task "+tk.ID+" cannot resume without session_id" {
		t.Fatalf("error = %q", err.Error())
	}

	updated, err := store.Get(tk.ID)
	if err != nil {
		t.Fatalf("get updated task: %v", err)
	}
	if updated.Status != "stopped" {
		t.Fatalf("status = %q, want %q", updated.Status, "stopped")
	}
}
