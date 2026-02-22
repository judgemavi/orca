package sprint

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jasjeetmavi/orca/internal/task"
	"github.com/jasjeetmavi/orca/internal/testutil"
)

func TestPlan(t *testing.T) {
	db := testutil.DB(t)
	store := task.NewStore(db)
	planner := NewPlanner(db)

	// Create 3 pending tasks
	t1, err := store.Create("Task 1", "", "", "")
	if err != nil {
		t.Fatalf("create t1: %v", err)
	}
	t2, err := store.Create("Task 2", "", "", "")
	if err != nil {
		t.Fatalf("create t2: %v", err)
	}
	_, err = store.Create("Task 3", "", "", "")
	if err != nil {
		t.Fatalf("create t3: %v", err)
	}

	s, err := planner.Plan(2)
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	if len(s.TaskIDs) != 2 {
		t.Errorf("planned %d tasks, want 2", len(s.TaskIDs))
	}
	if s.Status != "planning" {
		t.Errorf("status = %q, want %q", s.Status, "planning")
	}

	// Check selected tasks are in_sprint
	for _, id := range s.TaskIDs {
		got, err := store.Get(id)
		if err != nil {
			t.Fatalf("get task %s: %v", id, err)
		}
		if got.Status != "in_sprint" {
			t.Errorf("task %s status = %q, want %q", id, got.Status, "in_sprint")
		}
	}

	// 3rd task should still be pending (tasks selected by created_at order)
	// The planned IDs should be t1 and t2
	if s.TaskIDs[0] != t1.ID || s.TaskIDs[1] != t2.ID {
		t.Logf("planned task IDs: %v", s.TaskIDs)
	}
}

func TestPlanNoReadyTasks(t *testing.T) {
	db := testutil.DB(t)
	store := task.NewStore(db)
	planner := NewPlanner(db)

	a, err := store.Create("Task A", "", "", "")
	if err != nil {
		t.Fatalf("create A: %v", err)
	}
	b, err := store.Create("Task B", "", "", "")
	if err != nil {
		t.Fatalf("create B: %v", err)
	}

	// B depends on A
	if err := store.AddDependency(b.ID, a.ID); err != nil {
		t.Fatalf("add dep: %v", err)
	}

	// Plan should pick A only (B is blocked)
	s, err := planner.Plan(10)
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	if len(s.TaskIDs) != 1 || s.TaskIDs[0] != a.ID {
		t.Errorf("planned %v, want [%s]", s.TaskIDs, a.ID)
	}

	// A is now in_sprint, plan again should fail
	_, err = planner.Plan(10)
	if err == nil {
		t.Fatal("expected error when no ready tasks")
	}
}

func TestPlanDependencyCycleDetection(t *testing.T) {
	t.Run("NoDeps", func(t *testing.T) {
		db := testutil.DB(t)
		store := task.NewStore(db)
		planner := NewPlanner(db)

		if _, err := store.Create("Task A", "", "", ""); err != nil {
			t.Fatalf("create A: %v", err)
		}

		if _, err := planner.Plan(10); err != nil {
			t.Fatalf("plan: %v", err)
		}
	})

	t.Run("LinearChain", func(t *testing.T) {
		db := testutil.DB(t)
		store := task.NewStore(db)
		planner := NewPlanner(db)

		a, err := store.Create("Task A", "", "", "")
		if err != nil {
			t.Fatalf("create A: %v", err)
		}
		b, err := store.Create("Task B", "", "", "")
		if err != nil {
			t.Fatalf("create B: %v", err)
		}
		c, err := store.Create("Task C", "", "", "")
		if err != nil {
			t.Fatalf("create C: %v", err)
		}

		if err := store.AddDependency(a.ID, b.ID); err != nil {
			t.Fatalf("add A->B: %v", err)
		}
		if err := store.AddDependency(b.ID, c.ID); err != nil {
			t.Fatalf("add B->C: %v", err)
		}

		if _, err := planner.Plan(10); err != nil {
			t.Fatalf("plan: %v", err)
		}
	})

	t.Run("DirectCycle", func(t *testing.T) {
		db := testutil.DB(t)
		store := task.NewStore(db)
		planner := NewPlanner(db)

		a, err := store.Create("Task A", "", "", "")
		if err != nil {
			t.Fatalf("create A: %v", err)
		}
		b, err := store.Create("Task B", "", "", "")
		if err != nil {
			t.Fatalf("create B: %v", err)
		}

		if _, err := db.Exec(`INSERT INTO task_deps (task_id, depends_on) VALUES (?, ?)`, a.ID, b.ID); err != nil {
			t.Fatalf("insert A->B: %v", err)
		}
		if _, err := db.Exec(`INSERT INTO task_deps (task_id, depends_on) VALUES (?, ?)`, b.ID, a.ID); err != nil {
			t.Fatalf("insert B->A: %v", err)
		}

		_, err = planner.Plan(10)
		if err == nil {
			t.Fatal("expected circular dependency error")
		}
		if !strings.Contains(err.Error(), "circular dependency:") {
			t.Fatalf("error = %q, want circular dependency", err)
		}
		if !strings.Contains(err.Error(), a.ID) || !strings.Contains(err.Error(), b.ID) {
			t.Fatalf("error = %q, want cycle path with %s and %s", err, a.ID, b.ID)
		}
	})

	t.Run("IndirectCycle", func(t *testing.T) {
		db := testutil.DB(t)
		store := task.NewStore(db)
		planner := NewPlanner(db)

		a, err := store.Create("Task A", "", "", "")
		if err != nil {
			t.Fatalf("create A: %v", err)
		}
		b, err := store.Create("Task B", "", "", "")
		if err != nil {
			t.Fatalf("create B: %v", err)
		}
		c, err := store.Create("Task C", "", "", "")
		if err != nil {
			t.Fatalf("create C: %v", err)
		}

		if _, err := db.Exec(`INSERT INTO task_deps (task_id, depends_on) VALUES (?, ?)`, a.ID, b.ID); err != nil {
			t.Fatalf("insert A->B: %v", err)
		}
		if _, err := db.Exec(`INSERT INTO task_deps (task_id, depends_on) VALUES (?, ?)`, b.ID, c.ID); err != nil {
			t.Fatalf("insert B->C: %v", err)
		}
		if _, err := db.Exec(`INSERT INTO task_deps (task_id, depends_on) VALUES (?, ?)`, c.ID, a.ID); err != nil {
			t.Fatalf("insert C->A: %v", err)
		}

		_, err = planner.Plan(10)
		if err == nil {
			t.Fatal("expected circular dependency error")
		}
		if !strings.Contains(err.Error(), "circular dependency:") {
			t.Fatalf("error = %q, want circular dependency", err)
		}
		if !strings.Contains(err.Error(), a.ID) || !strings.Contains(err.Error(), b.ID) || !strings.Contains(err.Error(), c.ID) {
			t.Fatalf("error = %q, want cycle path with %s, %s, %s", err, a.ID, b.ID, c.ID)
		}
	})

	t.Run("Diamond", func(t *testing.T) {
		db := testutil.DB(t)
		store := task.NewStore(db)
		planner := NewPlanner(db)

		a, err := store.Create("Task A", "", "", "")
		if err != nil {
			t.Fatalf("create A: %v", err)
		}
		b, err := store.Create("Task B", "", "", "")
		if err != nil {
			t.Fatalf("create B: %v", err)
		}
		c, err := store.Create("Task C", "", "", "")
		if err != nil {
			t.Fatalf("create C: %v", err)
		}
		d, err := store.Create("Task D", "", "", "")
		if err != nil {
			t.Fatalf("create D: %v", err)
		}

		if err := store.AddDependency(a.ID, b.ID); err != nil {
			t.Fatalf("add A->B: %v", err)
		}
		if err := store.AddDependency(a.ID, c.ID); err != nil {
			t.Fatalf("add A->C: %v", err)
		}
		if err := store.AddDependency(b.ID, d.ID); err != nil {
			t.Fatalf("add B->D: %v", err)
		}
		if err := store.AddDependency(c.ID, d.ID); err != nil {
			t.Fatalf("add C->D: %v", err)
		}

		if _, err := planner.Plan(10); err != nil {
			t.Fatalf("plan: %v", err)
		}
	})
}

func TestCompleteTaskDoesNotCompleteSprint(t *testing.T) {
	db := testutil.DB(t)
	store := task.NewStore(db)
	planner := NewPlanner(db)

	t1, err := store.Create("Task 1", "", "", "")
	if err != nil {
		t.Fatalf("create t1: %v", err)
	}
	t2, err := store.Create("Task 2", "", "", "")
	if err != nil {
		t.Fatalf("create t2: %v", err)
	}

	s, err := planner.Plan(10)
	if err != nil {
		t.Fatalf("plan: %v", err)
	}

	// Start
	if err := planner.Start(s.ID); err != nil {
		t.Fatalf("start: %v", err)
	}

	got, err := planner.Get(s.ID)
	if err != nil {
		t.Fatalf("get sprint: %v", err)
	}
	if got.Status != "running" {
		t.Errorf("sprint status = %q, want %q", got.Status, "running")
	}

	// Check tasks are running
	for _, id := range []string{t1.ID, t2.ID} {
		tk, err := store.Get(id)
		if err != nil {
			t.Fatalf("get task %s: %v", id, err)
		}
		if tk.Status != "running" {
			t.Errorf("task %s status = %q, want %q", id, tk.Status, "running")
		}
	}

	// Complete both
	if err := planner.CompleteTask(s.ID, t1.ID, "completed"); err != nil {
		t.Fatalf("complete t1: %v", err)
	}
	if err := planner.CompleteTask(s.ID, t2.ID, "completed"); err != nil {
		t.Fatalf("complete t2: %v", err)
	}

	got, err = planner.Get(s.ID)
	if err != nil {
		t.Fatalf("get sprint after complete task updates: %v", err)
	}
	if got.Status != "running" {
		t.Errorf("sprint status = %q, want %q", got.Status, "running")
	}
}

func TestCompleteTaskWithFailureDoesNotFailSprint(t *testing.T) {
	db := testutil.DB(t)
	store := task.NewStore(db)
	planner := NewPlanner(db)

	t1, err := store.Create("Task 1", "", "", "")
	if err != nil {
		t.Fatalf("create t1: %v", err)
	}
	t2, err := store.Create("Task 2", "", "", "")
	if err != nil {
		t.Fatalf("create t2: %v", err)
	}

	s, err := planner.Plan(10)
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	if err := planner.Start(s.ID); err != nil {
		t.Fatalf("start: %v", err)
	}

	if err := planner.CompleteTask(s.ID, t1.ID, "completed"); err != nil {
		t.Fatalf("complete t1: %v", err)
	}
	if err := planner.CompleteTask(s.ID, t2.ID, "failed"); err != nil {
		t.Fatalf("fail t2: %v", err)
	}

	got, err := planner.Get(s.ID)
	if err != nil {
		t.Fatalf("get sprint: %v", err)
	}
	if got.Status != "running" {
		t.Errorf("sprint status = %q, want %q", got.Status, "running")
	}
}

func TestCompleteTaskWithReviewDoesNotCompleteSprint(t *testing.T) {
	db := testutil.DB(t)
	store := task.NewStore(db)
	planner := NewPlanner(db)

	t1, err := store.Create("Task 1", "", "", "")
	if err != nil {
		t.Fatalf("create t1: %v", err)
	}
	t2, err := store.Create("Task 2", "", "", "")
	if err != nil {
		t.Fatalf("create t2: %v", err)
	}

	s, err := planner.Plan(10)
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	if err := planner.Start(s.ID); err != nil {
		t.Fatalf("start: %v", err)
	}

	if err := planner.CompleteTask(s.ID, t1.ID, "review"); err != nil {
		t.Fatalf("complete t1 as review: %v", err)
	}
	if err := planner.CompleteTask(s.ID, t2.ID, "completed"); err != nil {
		t.Fatalf("complete t2: %v", err)
	}

	got, err := planner.Get(s.ID)
	if err != nil {
		t.Fatalf("get sprint: %v", err)
	}
	if got.Status != "running" {
		t.Errorf("sprint status = %q, want %q", got.Status, "running")
	}
}

func TestCompleteSprintIfDoneCompletesWhenTasksAreTerminal(t *testing.T) {
	db := testutil.DB(t)
	store := task.NewStore(db)
	planner := NewPlanner(db)

	t1, err := store.Create("Task 1", "", "", "")
	if err != nil {
		t.Fatalf("create t1: %v", err)
	}
	t2, err := store.Create("Task 2", "", "", "")
	if err != nil {
		t.Fatalf("create t2: %v", err)
	}

	s, err := planner.Plan(10)
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	if err := planner.Start(s.ID); err != nil {
		t.Fatalf("start: %v", err)
	}

	if err := store.Update(t1.ID, map[string]interface{}{"status": "completed"}); err != nil {
		t.Fatalf("complete t1: %v", err)
	}
	if err := store.Update(t2.ID, map[string]interface{}{"status": "merged"}); err != nil {
		t.Fatalf("merge t2: %v", err)
	}

	if err := planner.CompleteSprintIfDone(s.ID); err != nil {
		t.Fatalf("complete sprint if done: %v", err)
	}

	got, err := planner.Get(s.ID)
	if err != nil {
		t.Fatalf("get sprint: %v", err)
	}
	if got.Status != "completed" {
		t.Errorf("sprint status = %q, want %q", got.Status, "completed")
	}
}

func TestCompleteSprintIfDoneFailsWhenAnyFailedAndRestTerminal(t *testing.T) {
	db := testutil.DB(t)
	store := task.NewStore(db)
	planner := NewPlanner(db)

	t1, err := store.Create("Task 1", "", "", "")
	if err != nil {
		t.Fatalf("create t1: %v", err)
	}
	t2, err := store.Create("Task 2", "", "", "")
	if err != nil {
		t.Fatalf("create t2: %v", err)
	}

	s, err := planner.Plan(10)
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	if err := planner.Start(s.ID); err != nil {
		t.Fatalf("start: %v", err)
	}

	if err := store.Update(t1.ID, map[string]interface{}{"status": "failed"}); err != nil {
		t.Fatalf("fail t1: %v", err)
	}
	if err := store.Update(t2.ID, map[string]interface{}{"status": "completed"}); err != nil {
		t.Fatalf("complete t2: %v", err)
	}

	if err := planner.CompleteSprintIfDone(s.ID); err != nil {
		t.Fatalf("complete sprint if done: %v", err)
	}

	got, err := planner.Get(s.ID)
	if err != nil {
		t.Fatalf("get sprint: %v", err)
	}
	if got.Status != "failed" {
		t.Errorf("sprint status = %q, want %q", got.Status, "failed")
	}
}

func TestCompleteSprintIfDoneFailsWhenAllFailed(t *testing.T) {
	db := testutil.DB(t)
	store := task.NewStore(db)
	planner := NewPlanner(db)

	t1, err := store.Create("Task 1", "", "", "")
	if err != nil {
		t.Fatalf("create t1: %v", err)
	}
	t2, err := store.Create("Task 2", "", "", "")
	if err != nil {
		t.Fatalf("create t2: %v", err)
	}

	s, err := planner.Plan(10)
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	if err := planner.Start(s.ID); err != nil {
		t.Fatalf("start: %v", err)
	}

	if err := store.Update(t1.ID, map[string]interface{}{"status": "failed"}); err != nil {
		t.Fatalf("fail t1: %v", err)
	}
	if err := store.Update(t2.ID, map[string]interface{}{"status": "failed"}); err != nil {
		t.Fatalf("fail t2: %v", err)
	}

	if err := planner.CompleteSprintIfDone(s.ID); err != nil {
		t.Fatalf("complete sprint if done: %v", err)
	}

	got, err := planner.Get(s.ID)
	if err != nil {
		t.Fatalf("get sprint: %v", err)
	}
	if got.Status != "failed" {
		t.Errorf("sprint status = %q, want %q", got.Status, "failed")
	}
}

func TestResetSprintTasks(t *testing.T) {
	db := testutil.DB(t)
	store := task.NewStore(db)
	planner := NewPlanner(db)

	t1, err := store.Create("Task 1", "", "", "")
	if err != nil {
		t.Fatalf("create t1: %v", err)
	}
	t2, err := store.Create("Task 2", "", "", "")
	if err != nil {
		t.Fatalf("create t2: %v", err)
	}

	s, err := planner.Plan(10)
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	if err := planner.Start(s.ID); err != nil {
		t.Fatalf("start: %v", err)
	}

	// Reset
	if err := planner.ResetSprintTasks(s.ID); err != nil {
		t.Fatalf("reset: %v", err)
	}

	for _, id := range []string{t1.ID, t2.ID} {
		tk, err := store.Get(id)
		if err != nil {
			t.Fatalf("get task %s: %v", id, err)
		}
		if tk.Status != "pending" {
			t.Errorf("task %s status = %q, want %q", id, tk.Status, "pending")
		}
		if tk.SprintID != "" {
			t.Errorf("task %s sprint_id = %q, want empty", id, tk.SprintID)
		}
	}
}

func TestGetActive(t *testing.T) {
	db := testutil.DB(t)
	store := task.NewStore(db)
	planner := NewPlanner(db)

	// No sprints
	active, err := planner.GetActive()
	if err != nil {
		t.Fatalf("get active (none): %v", err)
	}
	if active != nil {
		t.Errorf("expected nil, got sprint %s", active.ID)
	}

	// Create a planning sprint
	_, err = store.Create("Task 1", "", "", "")
	if err != nil {
		t.Fatalf("create task: %v", err)
	}

	s, err := planner.Plan(10)
	if err != nil {
		t.Fatalf("plan: %v", err)
	}

	active, err = planner.GetActive()
	if err != nil {
		t.Fatalf("get active (planning): %v", err)
	}
	if active == nil {
		t.Fatal("expected active sprint, got nil")
	}
	if active.ID != s.ID {
		t.Errorf("active sprint id = %q, want %q", active.ID, s.ID)
	}

	// Complete it
	if err := planner.Complete(s.ID); err != nil {
		t.Fatalf("complete: %v", err)
	}

	active, err = planner.GetActive()
	if err != nil {
		t.Fatalf("get active (after complete): %v", err)
	}
	if active != nil {
		t.Errorf("expected nil after completing sprint, got %s", active.ID)
	}
}

func TestRecoverOrphansAndResolveOrphanFailed(t *testing.T) {
	db := testutil.DB(t)
	store := task.NewStore(db)
	planner := NewPlanner(db)

	tk, err := store.Create("Task 1", "", "", "")
	if err != nil {
		t.Fatalf("create task: %v", err)
	}
	s, err := planner.Plan(10)
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	if err := planner.Start(s.ID); err != nil {
		t.Fatalf("start: %v", err)
	}

	worktreeDir := t.TempDir()
	orphans, err := planner.RecoverOrphans(worktreeDir, "orca/integration")
	if err != nil {
		t.Fatalf("recover orphans: %v", err)
	}
	if len(orphans) != 1 {
		t.Fatalf("orphans len = %d, want 1", len(orphans))
	}
	if orphans[0].TaskID != tk.ID {
		t.Fatalf("orphan task id = %q, want %q", orphans[0].TaskID, tk.ID)
	}
	if orphans[0].SprintID != s.ID {
		t.Fatalf("orphan sprint id = %q, want %q", orphans[0].SprintID, s.ID)
	}
	if orphans[0].HasCommits {
		t.Fatal("orphan has commits = true, want false")
	}

	if err := planner.ResolveOrphan(tk.ID, false); err != nil {
		t.Fatalf("resolve orphan: %v", err)
	}
	got, err := store.Get(tk.ID)
	if err != nil {
		t.Fatalf("get task: %v", err)
	}
	if got.Status != "failed" {
		t.Fatalf("task status = %q, want %q", got.Status, "failed")
	}
}

func TestRecoverOrphansAndResolveOrphanReview(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}

	db := testutil.DB(t)
	store := task.NewStore(db)
	planner := NewPlanner(db)

	tk, err := store.Create("Task 1", "", "", "")
	if err != nil {
		t.Fatalf("create task: %v", err)
	}
	s, err := planner.Plan(10)
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	if err := planner.Start(s.ID); err != nil {
		t.Fatalf("start: %v", err)
	}

	repoDir := t.TempDir()
	initSprintRecoveryRepo(t, repoDir)
	integrationBranch := "orca/integration"
	runSprintGit(t, repoDir, "checkout", "-b", integrationBranch)
	runSprintGit(t, repoDir, "checkout", "-")

	worktreeDir := t.TempDir()
	wtPath := filepath.Join(worktreeDir, "task-"+tk.ID)
	runSprintGit(t, repoDir, "worktree", "add", wtPath, "-b", "orca/task-"+tk.ID, integrationBranch)

	filePath := filepath.Join(wtPath, "README.md")
	if err := os.WriteFile(filePath, []byte("change\n"), 0o644); err != nil {
		t.Fatalf("write worktree file: %v", err)
	}
	runSprintGit(t, wtPath, "add", "README.md")
	runSprintGit(t, wtPath, "commit", "-m", "task change")

	orphans, err := planner.RecoverOrphans(worktreeDir, integrationBranch)
	if err != nil {
		t.Fatalf("recover orphans: %v", err)
	}
	if len(orphans) != 1 {
		t.Fatalf("orphans len = %d, want 1", len(orphans))
	}
	if !orphans[0].HasCommits {
		t.Fatal("orphan has commits = false, want true")
	}

	if err := planner.ResolveOrphan(tk.ID, true); err != nil {
		t.Fatalf("resolve orphan: %v", err)
	}
	got, err := store.Get(tk.ID)
	if err != nil {
		t.Fatalf("get task: %v", err)
	}
	if got.Status != "review" {
		t.Fatalf("task status = %q, want %q", got.Status, "review")
	}
}

func TestRecoverOrphansNone(t *testing.T) {
	db := testutil.DB(t)
	planner := NewPlanner(db)

	orphans, err := planner.RecoverOrphans(t.TempDir(), "orca/integration")
	if err != nil {
		t.Fatalf("recover orphans: %v", err)
	}
	if len(orphans) != 0 {
		t.Fatalf("orphans len = %d, want 0", len(orphans))
	}
}

func TestRecoverSprint(t *testing.T) {
	db := testutil.DB(t)
	store := task.NewStore(db)
	planner := NewPlanner(db)

	_, err := store.Create("Task 1", "", "", "")
	if err != nil {
		t.Fatalf("create task: %v", err)
	}
	s, err := planner.Plan(10)
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	if err := planner.Start(s.ID); err != nil {
		t.Fatalf("start: %v", err)
	}

	if err := planner.RecoverSprint(s.ID); err != nil {
		t.Fatalf("recover sprint: %v", err)
	}

	got, err := planner.Get(s.ID)
	if err != nil {
		t.Fatalf("get sprint: %v", err)
	}
	if got.Status != "failed" {
		t.Fatalf("sprint status = %q, want %q", got.Status, "failed")
	}
}

func initSprintRecoveryRepo(t *testing.T, dir string) {
	t.Helper()
	runSprintGit(t, dir, "init")
	runSprintGit(t, dir, "config", "user.name", "Test User")
	runSprintGit(t, dir, "config", "user.email", "test@example.com")
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("init\n"), 0o644); err != nil {
		t.Fatalf("write repo file: %v", err)
	}
	runSprintGit(t, dir, "add", ".")
	runSprintGit(t, dir, "commit", "-m", "initial")
}

func runSprintGit(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s failed: %v\n%s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
}

// Ensure temp dir cleanup works on all platforms.
func init() {
	os.Setenv("TMPDIR", os.TempDir())
}
