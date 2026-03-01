package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"reflect"
	"testing"
	"unsafe"

	"github.com/jasjeetmavi/orca/internal/executor"
	"github.com/jasjeetmavi/orca/internal/task"
	"github.com/jasjeetmavi/orca/internal/testutil"
)

func TestHandleStopTaskReturns400ForNonRunningTask(t *testing.T) {
	db := testutil.DB(t)
	store := task.NewStore(db)
	exec := executor.NewExecutor(context.Background(), db, store, nil, nil, t.TempDir(), executor.ExecutorOptions{})

	srv := &Server{
		taskStore: store,
		executor:  exec,
		hub:       NewHub(),
	}

	tk, err := store.Create("t1", "desc", "")
	if err != nil {
		t.Fatalf("create task: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/v1/tasks/"+tk.ID+"/stop", nil)
	rec := httptest.NewRecorder()
	srv.Routes().ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestHandleStopTaskReturnsStoppedTaskOnSuccess(t *testing.T) {
	db := testutil.DB(t)
	store := task.NewStore(db)
	exec := executor.NewExecutor(context.Background(), db, store, nil, nil, t.TempDir(), executor.ExecutorOptions{})

	srv := &Server{
		taskStore: store,
		executor:  exec,
		hub:       NewHub(),
	}

	tk, err := store.Create("t1", "desc", "")
	if err != nil {
		t.Fatalf("create task: %v", err)
	}
	if err := store.Update(tk.ID, map[string]interface{}{"status": "running"}); err != nil {
		t.Fatalf("set running: %v", err)
	}
	markExecutorTaskRunning(exec, tk.ID)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/tasks/"+tk.ID+"/stop", nil)
	rec := httptest.NewRecorder()
	srv.Routes().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}

	var payload struct {
		Data task.Task `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if payload.Data.Status != "stopped" {
		t.Fatalf("status = %q, want %q", payload.Data.Status, "stopped")
	}
}

func TestHandleCancelTaskAliasStillWorks(t *testing.T) {
	db := testutil.DB(t)
	store := task.NewStore(db)
	exec := executor.NewExecutor(context.Background(), db, store, nil, nil, t.TempDir(), executor.ExecutorOptions{})

	srv := &Server{
		taskStore: store,
		executor:  exec,
		hub:       NewHub(),
	}

	tk, err := store.Create("t1", "desc", "")
	if err != nil {
		t.Fatalf("create task: %v", err)
	}
	if err := store.Update(tk.ID, map[string]interface{}{"status": "running"}); err != nil {
		t.Fatalf("set running: %v", err)
	}
	markExecutorTaskRunning(exec, tk.ID)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/tasks/"+tk.ID+"/cancel", nil)
	rec := httptest.NewRecorder()
	srv.Routes().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
}

func TestHandleResumeTaskReturns400ForNonStoppedTask(t *testing.T) {
	db := testutil.DB(t)
	store := task.NewStore(db)
	exec := executor.NewExecutor(context.Background(), db, store, nil, nil, t.TempDir(), executor.ExecutorOptions{})

	srv := &Server{
		taskStore: store,
		executor:  exec,
		hub:       NewHub(),
	}

	tk, err := store.Create("t1", "desc", "")
	if err != nil {
		t.Fatalf("create task: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/v1/tasks/"+tk.ID+"/resume", nil)
	rec := httptest.NewRecorder()
	srv.Routes().ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestHandleResumeTaskReturns400WithoutSessionID(t *testing.T) {
	db := testutil.DB(t)
	store := task.NewStore(db)
	exec := executor.NewExecutor(context.Background(), db, store, nil, nil, t.TempDir(), executor.ExecutorOptions{})

	srv := &Server{
		taskStore: store,
		executor:  exec,
		hub:       NewHub(),
	}

	tk, err := store.Create("t1", "desc", "")
	if err != nil {
		t.Fatalf("create task: %v", err)
	}
	if err := store.Update(tk.ID, map[string]interface{}{"status": "stopped"}); err != nil {
		t.Fatalf("set stopped: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/v1/tasks/"+tk.ID+"/resume", nil)
	rec := httptest.NewRecorder()
	srv.Routes().ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusBadRequest)
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
