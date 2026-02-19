package autopilot

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jasjeetmavi/pod/internal/config"
	"github.com/jasjeetmavi/pod/internal/explore"
	"github.com/jasjeetmavi/pod/internal/review"
	"github.com/jasjeetmavi/pod/internal/sprint"
	"github.com/jasjeetmavi/pod/internal/state"
	"github.com/jasjeetmavi/pod/internal/task"
	"github.com/jasjeetmavi/pod/internal/worktree"
)

type autopilotHarness struct {
	db       *state.DB
	cfg      *config.Config
	planner  *sprint.Planner
	executor *sprint.Executor
	repoDir  string
}

func setupAutopilotHarness(t *testing.T) *autopilotHarness {
	t.Helper()

	repoDir := t.TempDir()

	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = repoDir
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, string(out))
		}
	}

	run("init")
	run("config", "user.email", "test@example.com")
	run("config", "user.name", "Test User")

	if err := os.WriteFile(filepath.Join(repoDir, "README.md"), []byte("test\n"), 0644); err != nil {
		t.Fatalf("write README.md: %v", err)
	}
	run("add", "README.md")
	run("commit", "-m", "initial")
	run("branch", "pod/integration")

	cfg := config.Default()
	cfg.Project.Name = "test-project"
	cfg.Project.WorktreeDir = filepath.Join(repoDir, "worktrees")

	cfgPath := filepath.Join(repoDir, "pod.yaml")
	if err := cfg.Save(cfgPath); err != nil {
		t.Fatalf("save config: %v", err)
	}

	db, err := state.Open(filepath.Join(repoDir, "state.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	planner := sprint.NewPlanner(db)
	wm := worktree.NewManager(repoDir, cfg.Project.WorktreeDir)
	executor := sprint.NewExecutor(planner, wm, cfg, repoDir)

	return &autopilotHarness{
		db:       db,
		cfg:      cfg,
		planner:  planner,
		executor: executor,
		repoDir:  repoDir,
	}
}

func TestRunAbortAfterPlan(t *testing.T) {
	h := setupAutopilotHarness(t)

	_, err := explore.WriteManualContext(h.repoDir, "manual context")
	if err != nil {
		t.Fatalf("write manual context: %v", err)
	}

	h.cfg.Tools = map[string]config.ToolConfig{
		"stub": {
			Binary:       "sh",
			HeadlessArgs: []string{"-c", `printf '[{"title":"Task 1","description":"Desc","depends_on_indices":[],"suggested_tool":""}]'`},
			Timeout:      "10s",
		},
	}

	sup := New(h.db, h.cfg, h.planner, h.executor, h.repoDir, Options{MaxSprints: 10, PauseOnReview: true})

	sawPlan := false
	err = sup.Run("test goal", func(event Event) bool {
		if event.Type == EventPlanProposed {
			sawPlan = true
			return false
		}
		return true
	})
	if err == nil {
		t.Fatal("expected abort error")
	}
	if !strings.Contains(err.Error(), "aborted after plan proposal") {
		t.Fatalf("expected plan abort error, got: %v", err)
	}
	if !sawPlan {
		t.Fatal("expected EventPlanProposed callback")
	}
}

func TestRunSprintLoopNoTasks(t *testing.T) {
	h := setupAutopilotHarness(t)
	h.cfg.Tools = map[string]config.ToolConfig{
		"echo": {
			Binary:       "echo",
			HeadlessArgs: []string{"{{prompt}}"},
			Timeout:      "10s",
		},
	}

	sup := New(h.db, h.cfg, h.planner, h.executor, h.repoDir, Options{MaxSprints: 10, PauseOnReview: true})

	var events []Event
	err := sup.RunSprintLoop(func(event Event) bool {
		events = append(events, event)
		return true
	})
	if err != nil {
		t.Fatalf("RunSprintLoop: %v", err)
	}
	if len(events) == 0 {
		t.Fatal("expected at least one callback event")
	}
	last := events[len(events)-1]
	if last.Type != EventProgress || last.Message != "Autopilot complete" {
		t.Fatalf("last event = %+v, want progress/autopilot complete", last)
	}
}

func TestRunSprintLoopMaxSprints(t *testing.T) {
	h := setupAutopilotHarness(t)
	h.cfg.Workers.MaxParallel = 2
	h.cfg.Tools = map[string]config.ToolConfig{
		"echo": {
			Binary:       "echo",
			HeadlessArgs: []string{"{{prompt}}"},
			Timeout:      "10s",
		},
	}

	store := task.NewStore(h.db)
	for i := 0; i < 5; i++ {
		if _, err := store.Create("Task", "Desc", "", "echo"); err != nil {
			t.Fatalf("create task %d: %v", i+1, err)
		}
	}

	sup := New(h.db, h.cfg, h.planner, h.executor, h.repoDir, Options{MaxSprints: 1, PauseOnReview: true})

	sprintCompleteEvents := 0
	err := sup.RunSprintLoop(func(event Event) bool {
		if event.Type == EventSprintComplete {
			sprintCompleteEvents++
		}
		return true
	})
	if err != nil {
		t.Fatalf("RunSprintLoop: %v", err)
	}
	if sprintCompleteEvents != 1 {
		t.Fatalf("sprint complete events = %d, want 1", sprintCompleteEvents)
	}

	completed, err := store.ListByStatus("completed")
	if err != nil {
		t.Fatalf("list completed: %v", err)
	}
	if len(completed) != 2 {
		t.Fatalf("completed tasks = %d, want 2", len(completed))
	}

	pending, err := store.ListByStatus("pending")
	if err != nil {
		t.Fatalf("list pending: %v", err)
	}
	if len(pending) != 3 {
		t.Fatalf("pending tasks = %d, want 3", len(pending))
	}
}

func TestEscalation(t *testing.T) {
	sup := &Supervisor{retryCount: make(map[string]int)}
	taskID := "task-1"

	sup.RecordFailure(taskID)
	if got := sup.ShouldEscalate(taskID, 2); got {
		t.Fatalf("ShouldEscalate after 1 failure = %v, want false", got)
	}

	sup.RecordFailure(taskID)
	if got := sup.ShouldEscalate(taskID, 2); !got {
		t.Fatalf("ShouldEscalate after 2 failures = %v, want true", got)
	}
}

func TestResetFailedTask(t *testing.T) {
	h := setupAutopilotHarness(t)
	store := task.NewStore(h.db)

	tk, err := store.Create("Task", "Desc", "", "")
	if err != nil {
		t.Fatalf("create task: %v", err)
	}

	if _, err := h.db.Exec(`INSERT INTO sprints (id, status) VALUES ('sprint-1', 'failed')`); err != nil {
		t.Fatalf("insert sprint: %v", err)
	}
	if err := store.Update(tk.ID, map[string]interface{}{"status": "failed", "sprint_id": "sprint-1"}); err != nil {
		t.Fatalf("set failed status: %v", err)
	}

	sup := New(h.db, h.cfg, h.planner, h.executor, h.repoDir, Options{MaxSprints: 1, PauseOnReview: true})
	if err := sup.resetFailedTask(tk.ID); err != nil {
		t.Fatalf("resetFailedTask: %v", err)
	}

	got, err := store.Get(tk.ID)
	if err != nil {
		t.Fatalf("get task: %v", err)
	}
	if got.Status != "pending" {
		t.Fatalf("status = %q, want pending", got.Status)
	}
	if got.SprintID != "" {
		t.Fatalf("sprint_id = %q, want empty", got.SprintID)
	}
}

func TestCollectMergeableTaskIDs(t *testing.T) {
	sup := &Supervisor{}
	results := []sprint.TaskResult{
		{TaskID: "t1", Status: "completed"},
		{TaskID: "t2", Status: "completed"},
		{TaskID: "t3", Status: "failed"},
	}
	reviews := []review.ReviewResult{
		{TaskID: "t1", Approved: true},
		{TaskID: "t2", Approved: false},
	}

	ids := sup.collectMergeableTaskIDs(results, reviews)
	if len(ids) != 1 || ids[0] != "t1" {
		t.Fatalf("mergeable ids = %v, want [t1]", ids)
	}
}
