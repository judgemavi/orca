package executor

import (
	"context"
	"os"
	"os/exec"
	"testing"
	"time"

	"github.com/jasjeetmavi/orca/internal/driver"
	"github.com/jasjeetmavi/orca/internal/interaction"
	"github.com/jasjeetmavi/orca/internal/task"
	"github.com/jasjeetmavi/orca/internal/testutil"
)

func TestNewRunContextUsesParentCancellation(t *testing.T) {
	parentCtx, cancelParent := context.WithCancel(context.Background())
	e := NewExecutor(parentCtx, nil, nil, nil, nil, t.TempDir(), ExecutorOptions{})

	runCtx, cancelRun := e.newRunContext()
	defer cancelRun()

	cancelParent()

	select {
	case <-runCtx.Done():
	case <-time.After(200 * time.Millisecond):
		t.Fatal("run context was not canceled after parent context cancellation")
	}

	if got, want := runCtx.Err(), context.Canceled; got != want {
		t.Fatalf("run context err = %v, want %v", got, want)
	}
}

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

func TestResolveResumeRunStateIncludesPendingReviewForFailedTask(t *testing.T) {
	db := testutil.DB(t)
	store := task.NewStore(db)
	e := &Executor{taskStore: store}

	tk, err := store.Create("t1", "desc", "")
	if err != nil {
		t.Fatalf("create task: %v", err)
	}
	if err := store.Update(tk.ID, map[string]interface{}{"status": "failed"}); err != nil {
		t.Fatalf("set failed status: %v", err)
	}
	reviewID, err := store.AddReview(tk.ID, "Please fix edge-case handling", "")
	if err != nil {
		t.Fatalf("add review: %v", err)
	}

	d, ok := driver.Get("codex")
	if !ok {
		t.Fatal("driver codex not found")
	}
	wtPath := t.TempDir()
	if err := os.MkdirAll(wtPath, 0o755); err != nil {
		t.Fatalf("create worktree path: %v", err)
	}

	state, err := e.resolveResumeRunState(tk.ID, "sess-123", d, "gpt-5-codex", wtPath, false)
	if err != nil {
		t.Fatalf("resolve resume state: %v", err)
	}
	if state.reviewID != reviewID {
		t.Fatalf("reviewID = %q, want %q", state.reviewID, reviewID)
	}
	if state.feedback != "Please fix edge-case handling" {
		t.Fatalf("feedback = %q", state.feedback)
	}
	if state.resumeSessionID != "sess-123" {
		t.Fatalf("resumeSessionID = %q", state.resumeSessionID)
	}
	if len(state.args) == 0 {
		t.Fatal("expected resume args for session-based revise")
	}

	phase := interaction.PhaseRun
	if state.reviewID != "" {
		phase = interaction.PhaseRevise
	}
	if phase != interaction.PhaseRevise {
		t.Fatalf("phase = %q, want %q", phase, interaction.PhaseRevise)
	}
}
