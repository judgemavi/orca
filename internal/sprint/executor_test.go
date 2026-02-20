package sprint

import (
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jasjeetmavi/pod/internal/config"
	"github.com/jasjeetmavi/pod/internal/explore"
	"github.com/jasjeetmavi/pod/internal/task"
	"github.com/jasjeetmavi/pod/internal/worktree"
)

func initExecutorRepo(t *testing.T, dir string) {
	t.Helper()
	for _, args := range [][]string{
		{"init"},
		{"config", "user.email", "test@test.com"},
		{"config", "user.name", "Test"},
		{"commit", "--allow-empty", "-m", "init"},
	} {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
}

func setupExecutor(t *testing.T, toolCfg config.ToolConfig) (*Executor, *Planner, *task.Store, string) {
	t.Helper()

	repoDir := t.TempDir()
	initExecutorRepo(t, repoDir)

	db := testDB(t)
	planner := NewPlanner(db)
	store := task.NewStore(db)

	cfg := &config.Config{
		Project: config.ProjectConfig{
			IntegrationBranch: "pod/integration",
		},
		Tools: map[string]config.ToolConfig{
			"claude": toolCfg,
		},
	}

	wm := worktree.NewManager(repoDir, filepath.Join(t.TempDir(), "worktrees"))
	return NewExecutor(planner, wm, cfg, repoDir), planner, store, repoDir
}

func TestExecutorRunInjectsPlanIntoPrompt(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}

	execu, planner, store, repoDir := setupExecutor(t, config.ToolConfig{
		Binary:       "echo",
		HeadlessArgs: []string{"{{prompt}}"},
		Timeout:      "30s",
		Mode:         "headless",
	})

	tk, err := store.Create("Build feature", "Implement API endpoint", "", "claude")
	if err != nil {
		t.Fatalf("create task: %v", err)
	}
	if err := store.Update(tk.ID, map[string]interface{}{"plan": "1. Add handler\n2. Add tests"}); err != nil {
		t.Fatalf("set plan: %v", err)
	}
	if _, err := explore.WriteManualContext(repoDir, "Repository conventions and layout."); err != nil {
		t.Fatalf("write context: %v", err)
	}

	s, err := planner.Plan(1)
	if err != nil {
		t.Fatalf("plan sprint: %v", err)
	}
	results, err := execu.Run(s)
	if err != nil {
		t.Fatalf("run sprint: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("results len = %d, want 1", len(results))
	}

	got := results[0].Stdout
	idxContext := strings.Index(got, "## Codebase Context")
	idxPlan := strings.Index(got, "## Implementation Plan")
	idxTask := strings.Index(got, "## Task")
	if idxContext == -1 || idxPlan == -1 || idxTask == -1 {
		t.Fatalf("stdout missing expected sections:\n%s", got)
	}
	if !(idxContext < idxPlan && idxPlan < idxTask) {
		t.Fatalf("section order incorrect, stdout:\n%s", got)
	}
	if !strings.Contains(got, "Add handler") {
		t.Fatalf("stdout missing plan content:\n%s", got)
	}
}

func TestExecutorRunAppliesTaskModelOverride(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}

	execu, planner, store, _ := setupExecutor(t, config.ToolConfig{
		Binary:       "echo",
		HeadlessArgs: []string{"{{prompt}}"},
		Model:        "tool-default-model",
		Timeout:      "30s",
		Mode:         "headless",
	})

	tk, err := store.Create("Task", "Desc", "", "claude")
	if err != nil {
		t.Fatalf("create task: %v", err)
	}
	if err := store.Update(tk.ID, map[string]interface{}{
		"prompt": "run model-sensitive flow",
		"model":  "task-model-override",
	}); err != nil {
		t.Fatalf("update task fields: %v", err)
	}

	s, err := planner.Plan(1)
	if err != nil {
		t.Fatalf("plan sprint: %v", err)
	}
	results, err := execu.Run(s)
	if err != nil {
		t.Fatalf("run sprint: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("results len = %d, want 1", len(results))
	}

	got := results[0].Stdout
	if !strings.Contains(got, "--model task-model-override") {
		t.Fatalf("stdout missing task model override:\n%s", got)
	}
	if strings.Contains(got, "--model tool-default-model") {
		t.Fatalf("stdout still uses default tool model:\n%s", got)
	}
}

func TestExecutorRunWithoutPlanOrTaskModelKeepsExistingBehavior(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}

	execu, planner, store, _ := setupExecutor(t, config.ToolConfig{
		Binary:       "echo",
		HeadlessArgs: []string{"{{prompt}}"},
		Model:        "tool-default-model",
		Timeout:      "30s",
		Mode:         "headless",
	})

	_, err := store.Create("Legacy title", "Legacy description", "", "claude")
	if err != nil {
		t.Fatalf("create task: %v", err)
	}

	s, err := planner.Plan(1)
	if err != nil {
		t.Fatalf("plan sprint: %v", err)
	}
	results, err := execu.Run(s)
	if err != nil {
		t.Fatalf("run sprint: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("results len = %d, want 1", len(results))
	}

	got := results[0].Stdout
	if strings.Contains(got, "## Implementation Plan") {
		t.Fatalf("unexpected implementation plan section:\n%s", got)
	}
	if !strings.Contains(got, "Legacy title") || !strings.Contains(got, "Legacy description") {
		t.Fatalf("stdout missing legacy title/description prompt:\n%s", got)
	}
	if !strings.Contains(got, "--model tool-default-model") {
		t.Fatalf("stdout missing default tool model:\n%s", got)
	}
}
