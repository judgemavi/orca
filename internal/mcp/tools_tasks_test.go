package mcp

import (
	"encoding/json"
	"os/exec"
	"reflect"
	"strings"
	"testing"
	"unsafe"

	"github.com/jasjeetmavi/orca/internal/executor"
	"github.com/jasjeetmavi/orca/internal/task"
	"github.com/jasjeetmavi/orca/internal/testutil"
)

func TestHandleTasksStopTool(t *testing.T) {
	db := testutil.DB(t)
	store := task.NewStore(db)
	exec := executor.NewExecutor(db, store, nil, nil, t.TempDir(), executor.ExecutorOptions{})
	s := &Server{taskStore: store, executor: exec}

	tk, err := store.Create("t1", "desc", "")
	if err != nil {
		t.Fatalf("create task: %v", err)
	}
	if err := store.Update(tk.ID, map[string]interface{}{"status": "running"}); err != nil {
		t.Fatalf("set running: %v", err)
	}
	markExecutorTaskRunning(exec, tk.ID)

	got, err := s.HandleTasksStopTool(json.RawMessage(`{"task_id":"` + tk.ID + `"}`))
	if err != nil {
		t.Fatalf("HandleTasksStopTool returned error: %v", err)
	}

	m, ok := got.(map[string]interface{})
	if !ok {
		t.Fatalf("unexpected response type %T", got)
	}
	if m["status"] != "stopped" {
		t.Fatalf("status = %v, want stopped", m["status"])
	}
}

func TestHandleTasksResumeToolRequiresStoppedStatus(t *testing.T) {
	db := testutil.DB(t)
	store := task.NewStore(db)
	s := &Server{taskStore: store}

	tk, err := store.Create("t1", "desc", "")
	if err != nil {
		t.Fatalf("create task: %v", err)
	}
	if err := store.Update(tk.ID, map[string]interface{}{
		"status":     "failed",
		"session_id": "session-1",
	}); err != nil {
		t.Fatalf("set failed status with session_id: %v", err)
	}

	_, err = s.HandleTasksResumeTool(json.RawMessage(`{"task_id":"` + tk.ID + `"}`))
	if err != nil {
		if !strings.Contains(err.Error(), "only stopped tasks can be resumed") {
			t.Fatalf("unexpected error: %v", err)
		}
		return
	}
	t.Fatal("expected error for non-stopped task")
}

func TestHandleTasksResumeToolRequiresSessionID(t *testing.T) {
	db := testutil.DB(t)
	store := task.NewStore(db)
	s := &Server{taskStore: store}

	tk, err := store.Create("t1", "desc", "")
	if err != nil {
		t.Fatalf("create task: %v", err)
	}
	if err := store.Update(tk.ID, map[string]interface{}{"status": "stopped"}); err != nil {
		t.Fatalf("set stopped: %v", err)
	}

	_, err = s.HandleTasksResumeTool(json.RawMessage(`{"task_id":"` + tk.ID + `"}`))
	if err != nil {
		if !strings.Contains(err.Error(), "cannot resume without session_id") {
			t.Fatalf("unexpected error: %v", err)
		}
		return
	}
	t.Fatal("expected error for missing session_id")
}

func TestToolHandlersTaskAliasesAndRemovals(t *testing.T) {
	s := &Server{}
	handlers := s.toolHandlers()

	for _, name := range []string{"tasks_start", "tasks_stop", "tasks_resume"} {
		if _, ok := handlers[name]; !ok {
			t.Fatalf("expected handler %q to exist", name)
		}
	}
	for _, removed := range []string{"tasks_reopen", "task_reopen", "tasks_run", "tasks_cancel"} {
		if _, ok := handlers[removed]; ok {
			t.Fatalf("expected handler %q to be removed", removed)
		}
	}
}

func markExecutorTaskRunning(execInst *executor.Executor, taskID string) {
	field := reflect.ValueOf(execInst).Elem().FieldByName("running")
	running := (*map[string]*exec.Cmd)(unsafe.Pointer(field.UnsafeAddr()))
	if *running == nil {
		*running = make(map[string]*exec.Cmd)
	}
	(*running)[taskID] = nil
}
