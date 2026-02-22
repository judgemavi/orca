package sprint

import (
	"bytes"
	"context"
	"log"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jasjeetmavi/pod/internal/config"
	"github.com/jasjeetmavi/pod/internal/explore"
	"github.com/jasjeetmavi/pod/internal/task"
	"github.com/jasjeetmavi/pod/internal/testutil"
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

	db := testutil.DB(t)
	planner := NewPlanner(db)
	store := task.NewStore(db)

	cfg := &config.Config{
		Project: config.ProjectConfig{
			IntegrationBranch: "pod/integration",
			WorktreeDir:       filepath.Join(t.TempDir(), "worktrees"),
		},
		Tools: map[string]config.ToolConfig{
			"claude": toolCfg,
		},
	}

	wm := worktree.NewManager(repoDir, cfg.Project.WorktreeDir)
	return NewExecutor(planner, wm, cfg, repoDir, ExecutorOptions{}), planner, store, repoDir
}

func captureLogs(t *testing.T) (*bytes.Buffer, func()) {
	t.Helper()
	var buf bytes.Buffer
	prev := log.Writer()
	log.SetOutput(&buf)
	return &buf, func() {
		log.SetOutput(prev)
	}
}

func TestResolveTaskToolConfig_PhaseOverride(t *testing.T) {
	e := &Executor{
		config: &config.Config{
			Tools: map[string]config.ToolConfig{
				"claude": {Binary: "claude", Model: "claude-default"},
				"codex":  {Binary: "codex", Model: "codex-default"},
			},
			Defaults: config.DefaultsConfig{Tool: "claude"},
		},
	}
	tk := &task.Task{
		AssignedTool: "claude",
		PhaseConfig: &task.PhaseConfigMap{
			Phases: map[string]task.PhaseOverride{
				"sprint": {Tool: "codex"},
			},
		},
	}

	toolName, _, err := e.resolveTaskToolConfig(tk, "sprint")
	if err != nil {
		t.Fatalf("resolveTaskToolConfig: %v", err)
	}
	if toolName != "codex" {
		t.Fatalf("toolName = %q, want %q", toolName, "codex")
	}
}

func TestResolveTaskToolConfig_FallbackToAssignedTool(t *testing.T) {
	e := &Executor{
		config: &config.Config{
			Tools: map[string]config.ToolConfig{
				"claude": {Binary: "claude", Model: "claude-default"},
				"codex":  {Binary: "codex", Model: "codex-default"},
			},
			Defaults: config.DefaultsConfig{Tool: "claude"},
		},
	}
	tk := &task.Task{AssignedTool: "codex"}

	toolName, _, err := e.resolveTaskToolConfig(tk, "sprint")
	if err != nil {
		t.Fatalf("resolveTaskToolConfig: %v", err)
	}
	if toolName != "codex" {
		t.Fatalf("toolName = %q, want %q", toolName, "codex")
	}
}

func TestResolveTaskToolConfig_FallbackToConfigDefaults(t *testing.T) {
	e := &Executor{
		config: &config.Config{
			Tools: map[string]config.ToolConfig{
				"claude": {Binary: "claude", Model: "claude-default"},
				"codex":  {Binary: "codex", Model: "codex-default"},
			},
			Defaults: config.DefaultsConfig{Tool: "codex"},
		},
	}
	tk := &task.Task{}

	toolName, _, err := e.resolveTaskToolConfig(tk, "sprint")
	if err != nil {
		t.Fatalf("resolveTaskToolConfig: %v", err)
	}
	if toolName != "codex" {
		t.Fatalf("toolName = %q, want %q", toolName, "codex")
	}
}

func TestResolveTaskToolConfig_UseDefaultsSkipsPhases(t *testing.T) {
	e := &Executor{
		config: &config.Config{
			Tools: map[string]config.ToolConfig{
				"claude": {Binary: "claude", Model: "claude-default"},
				"codex":  {Binary: "codex", Model: "codex-default"},
			},
			Defaults: config.DefaultsConfig{Tool: "claude"},
		},
	}
	tk := &task.Task{
		PhaseConfig: &task.PhaseConfigMap{
			UseDefaults: true,
			Phases: map[string]task.PhaseOverride{
				"sprint": {Tool: "codex"},
			},
		},
	}

	toolName, _, err := e.resolveTaskToolConfig(tk, "sprint")
	if err != nil {
		t.Fatalf("resolveTaskToolConfig: %v", err)
	}
	if toolName != "claude" {
		t.Fatalf("toolName = %q, want %q", toolName, "claude")
	}
}

func TestResolveTaskToolConfig_StaleTool(t *testing.T) {
	e := &Executor{
		config: &config.Config{
			Tools: map[string]config.ToolConfig{
				"claude": {Binary: "claude", Model: "claude-default"},
			},
			Defaults: config.DefaultsConfig{Tool: "claude"},
		},
	}
	tk := &task.Task{
		PhaseConfig: &task.PhaseConfigMap{
			Phases: map[string]task.PhaseOverride{
				"sprint": {Tool: "removed_tool"},
			},
		},
	}

	logs, restore := captureLogs(t)
	defer restore()

	toolName, _, err := e.resolveTaskToolConfig(tk, "sprint")
	if err != nil {
		t.Fatalf("resolveTaskToolConfig: %v", err)
	}
	if toolName != "claude" {
		t.Fatalf("toolName = %q, want %q", toolName, "claude")
	}
	if !strings.Contains(logs.String(), `task phase_config tool "removed_tool" for phase "sprint" not found in config, falling back`) {
		t.Fatalf("missing stale tool warning, got logs:\n%s", logs.String())
	}
}

func TestResolveTaskToolConfig_StaleModel(t *testing.T) {
	e := &Executor{
		config: &config.Config{
			Tools: map[string]config.ToolConfig{
				"codex": {
					Binary: "codex",
					Model:  "tool-default-model",
					Models: []string{"tool-default-model", "allowed-model"},
				},
			},
			Defaults: config.DefaultsConfig{Tool: "codex"},
		},
	}
	tk := &task.Task{
		PhaseConfig: &task.PhaseConfigMap{
			Phases: map[string]task.PhaseOverride{
				"sprint": {Tool: "codex", Model: "stale-model"},
			},
		},
	}

	logs, restore := captureLogs(t)
	defer restore()

	toolName, toolCfg, err := e.resolveTaskToolConfig(tk, "sprint")
	if err != nil {
		t.Fatalf("resolveTaskToolConfig: %v", err)
	}
	if toolName != "codex" {
		t.Fatalf("toolName = %q, want %q", toolName, "codex")
	}
	if toolCfg.Model != "tool-default-model" {
		t.Fatalf("model = %q, want %q", toolCfg.Model, "tool-default-model")
	}
	if !strings.Contains(logs.String(), `task model "stale-model" not in codex models list, using default`) {
		t.Fatalf("missing stale model warning, got logs:\n%s", logs.String())
	}
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
		Models:       []string{"tool-default-model", "task-model-override"},
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

func TestExecutorRunFallsBackWhenAssignedToolMissingFromConfig(t *testing.T) {
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

	if _, err := store.Create("Task", "Desc", "", "codex"); err != nil {
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

	if results[0].ToolName != "claude" {
		t.Fatalf("tool name = %q, want fallback %q", results[0].ToolName, "claude")
	}
}

func TestExecutorRunFallsBackWhenTaskModelMissingFromToolModels(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}

	execu, planner, store, _ := setupExecutor(t, config.ToolConfig{
		Binary:       "echo",
		HeadlessArgs: []string{"{{prompt}}"},
		Model:        "tool-default-model",
		Models:       []string{"tool-default-model"},
		Timeout:      "30s",
		Mode:         "headless",
	})

	tk, err := store.Create("Task", "Desc", "", "claude")
	if err != nil {
		t.Fatalf("create task: %v", err)
	}
	if err := store.Update(tk.ID, map[string]interface{}{
		"prompt": "run model-sensitive flow",
		"model":  "stale-model",
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
	if !strings.Contains(got, "--model tool-default-model") {
		t.Fatalf("stdout missing default model fallback:\n%s", got)
	}
	if strings.Contains(got, "--model stale-model") {
		t.Fatalf("stdout still uses stale model override:\n%s", got)
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

func TestExecutorRunStoresSessionIDAndSetsReviewStatus(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}

	execu, planner, store, _ := setupExecutor(t, config.ToolConfig{
		Binary:           "echo",
		HeadlessArgs:     []string{"{{prompt}}"},
		SessionIDPattern: `session_id=([a-zA-Z0-9_-]+)`,
		Timeout:          "30s",
		Mode:             "headless",
	})

	tk, err := store.Create("Task", "Desc", "", "claude")
	if err != nil {
		t.Fatalf("create task: %v", err)
	}
	if err := store.Update(tk.ID, map[string]interface{}{"prompt": "session_id=session-123"}); err != nil {
		t.Fatalf("update task prompt: %v", err)
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
	if results[0].Status != "review" {
		t.Fatalf("result status = %q, want %q", results[0].Status, "review")
	}

	updated, err := store.Get(tk.ID)
	if err != nil {
		t.Fatalf("get task: %v", err)
	}
	if updated.Status != "review" {
		t.Fatalf("task status = %q, want %q", updated.Status, "review")
	}
	if updated.SessionID != "session-123" {
		t.Fatalf("session_id = %q, want %q", updated.SessionID, "session-123")
	}
}

func TestParseSessionID(t *testing.T) {
	if got := parseSessionID(`session=([a-z0-9-]+)`, "hello\nsession=abc-123\nbye"); got != "abc-123" {
		t.Fatalf("parseSessionID success = %q, want %q", got, "abc-123")
	}
	if got := parseSessionID(`session=([a-z0-9-]+)`, "no match"); got != "" {
		t.Fatalf("parseSessionID no match = %q, want empty", got)
	}
	if got := parseSessionID(`[invalid`, "session=abc"); got != "" {
		t.Fatalf("parseSessionID invalid regex = %q, want empty", got)
	}
}

func TestRunSingleUsesResumeArgsWhenSessionIDPresent(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}

	execu, planner, store, _ := setupExecutor(t, config.ToolConfig{
		Binary:           "echo",
		HeadlessArgs:     []string{"{{prompt}}"},
		ResumeArgs:       []string{"resume", "{{session_id}}", "{{feedback}}"},
		SessionIDPattern: `session_id=([a-zA-Z0-9_-]+)`,
		Timeout:          "30s",
		Mode:             "headless",
	})

	tk, err := store.Create("Task", "Desc", "", "claude")
	if err != nil {
		t.Fatalf("create task: %v", err)
	}
	if err := store.Update(tk.ID, map[string]interface{}{
		"prompt": "session_id=seed-session",
	}); err != nil {
		t.Fatalf("update task: %v", err)
	}

	s, err := planner.Plan(1)
	if err != nil {
		t.Fatalf("plan sprint: %v", err)
	}
	if _, err := execu.Run(s); err != nil {
		t.Fatalf("run sprint: %v", err)
	}
	if _, err := store.AddReview(tk.ID, "please adjust"); err != nil {
		t.Fatalf("add task review: %v", err)
	}
	if err := store.Update(tk.ID, map[string]interface{}{
		"session_id": "resume-session",
	}); err != nil {
		t.Fatalf("update task session: %v", err)
	}

	if err := execu.RunSingle(context.Background(), tk.ID); err != nil {
		t.Fatalf("run single: %v", err)
	}

	deadline := time.Now().Add(4 * time.Second)
	for {
		current, err := store.Get(tk.ID)
		if err != nil {
			t.Fatalf("get task: %v", err)
		}
		if current.Status == "review" || current.Status == "failed" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("timeout waiting for single run to finish, status=%s", current.Status)
		}
		time.Sleep(50 * time.Millisecond)
	}

	var stdout string
	err = planner.DB().QueryRow(
		`SELECT stdout FROM artifacts WHERE task_id = ? ORDER BY rowid DESC LIMIT 1`,
		tk.ID,
	).Scan(&stdout)
	if err != nil {
		t.Fatalf("load latest artifact stdout: %v", err)
	}
	if !strings.Contains(stdout, "resume resume-session please adjust") {
		t.Fatalf("latest artifact stdout missing resume args:\n%s", stdout)
	}

	updated, err := store.Get(tk.ID)
	if err != nil {
		t.Fatalf("get task after run single: %v", err)
	}
	if updated.Status != "review" {
		t.Fatalf("task status after run single = %q, want %q", updated.Status, "review")
	}
	if updated.SessionID == "" {
		t.Fatalf("session_id should be populated after run single")
	}
}
