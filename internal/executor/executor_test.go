package executor

import (
	"context"
	"os/exec"
	"testing"
	"time"

	"github.com/jasjeetmavi/orca/internal/interaction"
	"github.com/jasjeetmavi/orca/internal/memory"
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
	if err := store.Update(tk.ID, task.UpdateFields{Status: task.Ptr("running"), SessionID: task.Ptr("sess-123")}); err != nil {
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
	if err := store.Update(tk.ID, task.UpdateFields{Status: task.Ptr("stopped")}); err != nil {
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
	if err := store.Update(tk.ID, task.UpdateFields{Status: task.Ptr("failed")}); err != nil {
		t.Fatalf("set failed status: %v", err)
	}
	reviewID, err := store.AddReview(tk.ID, "Please fix edge-case handling", "")
	if err != nil {
		t.Fatalf("add review: %v", err)
	}

	state, err := e.resolveResumeRunState(tk.ID, "sess-123", false)
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

	phase := interaction.PhaseRun
	if state.reviewID != "" {
		phase = interaction.PhaseRevise
	}
	if phase != interaction.PhaseRevise {
		t.Fatalf("phase = %q, want %q", phase, interaction.PhaseRevise)
	}
}

func TestLoadUsedMemoryIDs(t *testing.T) {
	db := testutil.DB(t)
	store := task.NewStore(db)
	e := &Executor{db: db}

	tk, err := store.Create("memory ids task", "desc", "")
	if err != nil {
		t.Fatalf("create task: %v", err)
	}

	if _, err := db.Exec(
		`INSERT INTO task_interactions (id, task_id, phase, tool, log_path, status, quality_json)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		"plan-int-1",
		tk.ID,
		interaction.PhasePlan,
		"codex",
		"/tmp/plan-int-1.log",
		"completed",
		`{"used_memory_ids":["mem-1"," mem-1 ","mem-2"]}`,
	); err != nil {
		t.Fatalf("insert interaction: %v", err)
	}

	ids, err := e.loadUsedMemoryIDs(tk.ID)
	if err != nil {
		t.Fatalf("load used memory ids: %v", err)
	}
	if len(ids) != 2 || ids[0] != "mem-1" || ids[1] != "mem-2" {
		t.Fatalf("ids = %v, want [mem-1 mem-2]", ids)
	}
}

func TestReinforceMemoryConfidence(t *testing.T) {
	db := testutil.DB(t)
	store := task.NewStore(db)
	memoryStore := memory.NewStore(db)
	e := &Executor{
		db:          db,
		taskStore:   store,
		memoryStore: memoryStore,
	}

	entry := &memory.Entry{
		Content:        "confidence target",
		Category:       "pattern",
		Confidence:     0.5,
		ProvenanceHash: "exec-conf-hash",
	}
	if err := memoryStore.Create(entry); err != nil {
		t.Fatalf("create memory entry: %v", err)
	}

	tk, err := store.Create("reinforce", "desc", "")
	if err != nil {
		t.Fatalf("create task: %v", err)
	}
	if _, err := db.Exec(
		`INSERT INTO task_interactions (id, task_id, phase, tool, log_path, status, quality_json)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		"plan-int-2",
		tk.ID,
		interaction.PhasePlan,
		"codex",
		"/tmp/plan-int-2.log",
		"completed",
		`{"used_memory_ids":["`+entry.ID+`"]}`,
	); err != nil {
		t.Fatalf("insert interaction: %v", err)
	}

	e.reinforceMemoryConfidence(tk.ID, "review")
	afterReview, err := memoryStore.Get(entry.ID)
	if err != nil {
		t.Fatalf("get entry after review: %v", err)
	}
	if afterReview.Confidence != 0.55 {
		t.Fatalf("confidence after review = %v, want 0.55", afterReview.Confidence)
	}

	e.reinforceMemoryConfidence(tk.ID, "failed")
	afterFailed, err := memoryStore.Get(entry.ID)
	if err != nil {
		t.Fatalf("get entry after failed: %v", err)
	}
	if diff := afterFailed.Confidence - 0.495; diff < -1e-9 || diff > 1e-9 {
		t.Fatalf("confidence after failed = %v, want 0.495", afterFailed.Confidence)
	}
}
