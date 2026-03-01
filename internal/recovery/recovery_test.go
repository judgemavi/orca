package recovery

import (
	"fmt"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/jasjeetmavi/orca/internal/interaction"
	"github.com/jasjeetmavi/orca/internal/state"
	"github.com/jasjeetmavi/orca/internal/task"
	"github.com/jasjeetmavi/orca/internal/testutil"
)

func TestRecoverSequence(t *testing.T) {
	calls := make([]string, 0, 8)

	taskStore := &fakeTaskStore{
		calls: &calls,
		runningTasks: []*task.Task{
			{ID: "task-1", Status: "running", SessionID: "sess-1"},
		},
	}
	interactionStore := &fakeInteractionStore{
		calls: &calls,
		byTask: map[string][]interaction.Interaction{
			"task-1": {
				{ID: "i-1", Phase: interaction.PhaseRun},
			},
		},
	}
	sessionMgr := &fakeSessionMgr{calls: &calls}

	if err := Recover(nil, taskStore, interactionStore, sessionMgr); err != nil {
		t.Fatalf("recover: %v", err)
	}

	want := []string{
		"session.reconcile",
		"interactions.mark_stale",
		"tasks.list:running",
		"interactions.list:task-1",
		"tasks.update:task-1:stopped",
	}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("call order mismatch\n got: %v\nwant: %v", calls, want)
	}
}

func TestRecoverRunPhaseResetAndIdempotent(t *testing.T) {
	db := testutil.DB(t)
	taskStore := task.NewStore(db)
	interactionStore := interaction.NewStore(db, filepath.Join(t.TempDir(), "logs"))

	runTaskWithSession, err := taskStore.Create("run task (with session)", "", "")
	if err != nil {
		t.Fatalf("create run task with session: %v", err)
	}
	runTaskWithoutSession, err := taskStore.Create("run task (without session)", "", "")
	if err != nil {
		t.Fatalf("create run task without session: %v", err)
	}
	planTask, err := taskStore.Create("plan task", "", "")
	if err != nil {
		t.Fatalf("create plan task: %v", err)
	}
	noInteractionTask, err := taskStore.Create("no interaction task", "", "")
	if err != nil {
		t.Fatalf("create no interaction task: %v", err)
	}

	if err := taskStore.Update(runTaskWithSession.ID, map[string]interface{}{
		"status":     "running",
		"session_id": "sess-run",
	}); err != nil {
		t.Fatalf("set task %s running with session: %v", runTaskWithSession.ID, err)
	}
	for _, id := range []string{runTaskWithoutSession.ID, planTask.ID, noInteractionTask.ID} {
		if err := taskStore.Update(id, map[string]interface{}{"status": "running"}); err != nil {
			t.Fatalf("set task %s running: %v", id, err)
		}
	}

	now := time.Now().UTC()
	insertInteraction(t, db, "run-old", runTaskWithSession.ID, interaction.PhasePlan, "running", now.Add(-3*time.Minute))
	insertInteraction(t, db, "run-latest", runTaskWithSession.ID, interaction.PhaseRun, "running", now.Add(-2*time.Minute))
	insertInteraction(t, db, "run-no-session", runTaskWithoutSession.ID, interaction.PhaseRun, "running", now.Add(-90*time.Second))
	insertInteraction(t, db, "plan-old-run", planTask.ID, interaction.PhaseRun, "running", now.Add(-3*time.Minute))
	insertInteraction(t, db, "plan-latest", planTask.ID, interaction.PhasePlan, "running", now.Add(-2*time.Minute))

	sessionMgr := &fakeSessionMgr{}
	if err := Recover(db, taskStore, interactionStore, sessionMgr); err != nil {
		t.Fatalf("first recover: %v", err)
	}
	if sessionMgr.reconciled != 1 {
		t.Fatalf("session reconcile calls=%d want 1", sessionMgr.reconciled)
	}

	assertTaskStatus(t, taskStore, runTaskWithSession.ID, "stopped")
	assertTaskStatus(t, taskStore, runTaskWithoutSession.ID, "failed")
	assertTaskStatus(t, taskStore, planTask.ID, "running")
	assertTaskStatus(t, taskStore, noInteractionTask.ID, "running")

	runningInteractions, err := interactionStore.ListByStatus("running")
	if err != nil {
		t.Fatalf("list running interactions: %v", err)
	}
	if len(runningInteractions) != 0 {
		t.Fatalf("running interactions after recover=%d want 0", len(runningInteractions))
	}

	if err := Recover(db, taskStore, interactionStore, sessionMgr); err != nil {
		t.Fatalf("second recover: %v", err)
	}
	if sessionMgr.reconciled != 2 {
		t.Fatalf("session reconcile calls=%d want 2", sessionMgr.reconciled)
	}

	assertTaskStatus(t, taskStore, runTaskWithSession.ID, "stopped")
	assertTaskStatus(t, taskStore, runTaskWithoutSession.ID, "failed")
	assertTaskStatus(t, taskStore, planTask.ID, "running")
	assertTaskStatus(t, taskStore, noInteractionTask.ID, "running")
}

func TestFailInFlightForShutdownRunAndNonRunBehavior(t *testing.T) {
	db := testutil.DB(t)
	taskStore := task.NewStore(db)
	interactionStore := interaction.NewStore(db, filepath.Join(t.TempDir(), "logs"))

	runTaskWithSession, err := taskStore.Create("run task with session", "", "")
	if err != nil {
		t.Fatalf("create run task with session: %v", err)
	}
	runTaskWithoutSession, err := taskStore.Create("run task without session", "", "")
	if err != nil {
		t.Fatalf("create run task without session: %v", err)
	}
	nonRunTask, err := taskStore.Create("plan task", "", "")
	if err != nil {
		t.Fatalf("create non-run task: %v", err)
	}
	if err := taskStore.Update(runTaskWithSession.ID, map[string]interface{}{
		"status":     "running",
		"session_id": "sess-1",
	}); err != nil {
		t.Fatalf("set task %s running with session: %v", runTaskWithSession.ID, err)
	}
	for _, id := range []string{runTaskWithoutSession.ID, nonRunTask.ID} {
		if err := taskStore.Update(id, map[string]interface{}{"status": "running"}); err != nil {
			t.Fatalf("set task %s running: %v", id, err)
		}
	}

	now := time.Now().UTC()
	insertInteraction(t, db, "shutdown-run-stop", runTaskWithSession.ID, interaction.PhaseRun, "running", now.Add(-2*time.Minute))
	insertInteraction(t, db, "shutdown-run-fail", runTaskWithoutSession.ID, interaction.PhaseRun, "running", now.Add(-90*time.Second))
	insertInteraction(t, db, "shutdown-plan", nonRunTask.ID, interaction.PhasePlan, "running", now.Add(-time.Minute))

	runFailed, otherFailed, err := FailInFlightForShutdown(taskStore, interactionStore)
	if err != nil {
		t.Fatalf("fail in-flight interactions: %v", err)
	}
	if runFailed != 2 || otherFailed != 1 {
		t.Fatalf("counts run=%d nonrun=%d, want 2 and 1", runFailed, otherFailed)
	}

	assertTaskStatus(t, taskStore, runTaskWithSession.ID, "stopped")
	assertTaskStatus(t, taskStore, runTaskWithoutSession.ID, "failed")
	assertTaskStatus(t, taskStore, nonRunTask.ID, "running")

	runStopInteraction, err := interactionStore.Get("shutdown-run-stop")
	if err != nil {
		t.Fatalf("get stopped run interaction: %v", err)
	}
	if runStopInteraction.Status != "failed" {
		t.Fatalf("stopped run interaction status=%q want failed", runStopInteraction.Status)
	}
	if runStopInteraction.Error == "" {
		t.Fatal("stopped run interaction error should be set")
	}

	runFailInteraction, err := interactionStore.Get("shutdown-run-fail")
	if err != nil {
		t.Fatalf("get failed run interaction: %v", err)
	}
	if runFailInteraction.Status != "failed" {
		t.Fatalf("failed run interaction status=%q want failed", runFailInteraction.Status)
	}
	if runFailInteraction.Error == "" {
		t.Fatal("failed run interaction error should be set")
	}

	planInteraction, err := interactionStore.Get("shutdown-plan")
	if err != nil {
		t.Fatalf("get non-run interaction: %v", err)
	}
	if planInteraction.Status != "failed" {
		t.Fatalf("non-run interaction status=%q want failed", planInteraction.Status)
	}
	if planInteraction.Error == "" {
		t.Fatal("non-run interaction error should be set")
	}

	runFailed, otherFailed, err = FailInFlightForShutdown(taskStore, interactionStore)
	if err != nil {
		t.Fatalf("repeat fail in-flight interactions: %v", err)
	}
	if runFailed != 0 || otherFailed != 0 {
		t.Fatalf("repeat counts run=%d nonrun=%d, want 0 and 0", runFailed, otherFailed)
	}
}

func insertInteraction(
	t *testing.T,
	db *state.DB,
	id, taskID, phase, status string,
	startedAt time.Time,
) {
	t.Helper()
	if _, err := db.Exec(
		`INSERT INTO task_interactions (id, task_id, phase, attempt, tool, log_path, status, started_at)
		 VALUES (?, ?, ?, 1, 'claude', ?, ?, ?)`,
		id, taskID, phase, fmt.Sprintf("logs/%s.log", id), status, startedAt,
	); err != nil {
		t.Fatalf("insert interaction %s: %v", id, err)
	}
}

func assertTaskStatus(t *testing.T, store *task.Store, id, want string) {
	t.Helper()
	got, err := store.Get(id)
	if err != nil {
		t.Fatalf("get task %s: %v", id, err)
	}
	if got.Status != want {
		t.Fatalf("task %s status=%q want %q", id, got.Status, want)
	}
}

type fakeSessionMgr struct {
	calls      *[]string
	reconciled int
}

func (f *fakeSessionMgr) Reconcile() (int, error) {
	if f.calls != nil {
		*f.calls = append(*f.calls, "session.reconcile")
	}
	f.reconciled++
	return 0, nil
}

type fakeTaskStore struct {
	calls        *[]string
	runningTasks []*task.Task
}

func (f *fakeTaskStore) ListByStatus(status string) ([]*task.Task, error) {
	if f.calls != nil {
		*f.calls = append(*f.calls, "tasks.list:"+status)
	}
	return f.runningTasks, nil
}

func (f *fakeTaskStore) Update(id string, fields map[string]interface{}) error {
	status, _ := fields["status"].(string)
	if f.calls != nil {
		*f.calls = append(*f.calls, "tasks.update:"+id+":"+status)
	}
	return nil
}

type fakeInteractionStore struct {
	calls  *[]string
	byTask map[string][]interaction.Interaction
}

func (f *fakeInteractionStore) MarkStaleAsFailed() error {
	if f.calls != nil {
		*f.calls = append(*f.calls, "interactions.mark_stale")
	}
	return nil
}

func (f *fakeInteractionStore) List(taskID string) ([]interaction.Interaction, error) {
	if f.calls != nil {
		*f.calls = append(*f.calls, "interactions.list:"+taskID)
	}
	return f.byTask[taskID], nil
}
