package config

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func normalizeSlice(v []string) []string {
	if v == nil {
		return []string{}
	}
	return v
}

func assertConfigEquivalent(t *testing.T, got, want *Config) {
	t.Helper()

	if got.Project != want.Project {
		t.Fatalf("project mismatch: got=%+v want=%+v", got.Project, want.Project)
	}
	if got.Workers != want.Workers {
		t.Fatalf("workers mismatch: got=%+v want=%+v", got.Workers, want.Workers)
	}
	if got.Autopilot != want.Autopilot {
		t.Fatalf("autopilot mismatch: got=%+v want=%+v", got.Autopilot, want.Autopilot)
	}
	if !reflect.DeepEqual(normalizeSlice(got.Validation.Commands), normalizeSlice(want.Validation.Commands)) {
		t.Fatalf("validation commands mismatch: got=%v want=%v", got.Validation.Commands, want.Validation.Commands)
	}

	if len(got.Tools) != len(want.Tools) {
		t.Fatalf("tool count mismatch: got=%d want=%d", len(got.Tools), len(want.Tools))
	}
	for name, wantTool := range want.Tools {
		gotTool, ok := got.Tools[name]
		if !ok {
			t.Fatalf("missing tool %q after load", name)
		}
		if gotTool.Binary != wantTool.Binary ||
			gotTool.Timeout != wantTool.Timeout ||
			gotTool.Mode != wantTool.Mode ||
			gotTool.PromptMode != wantTool.PromptMode ||
			!reflect.DeepEqual(normalizeSlice(gotTool.InteractiveArgs), normalizeSlice(wantTool.InteractiveArgs)) ||
			!reflect.DeepEqual(normalizeSlice(gotTool.HeadlessArgs), normalizeSlice(wantTool.HeadlessArgs)) {
			t.Fatalf("tool %q mismatch: got=%+v want=%+v", name, gotTool, wantTool)
		}
	}
}

func TestDefault(t *testing.T) {
	cfg := Default()

	if cfg.Project.IntegrationBranch != "pod/integration" {
		t.Fatalf("integration_branch = %q, want %q", cfg.Project.IntegrationBranch, "pod/integration")
	}

	claude, ok := cfg.Tools["claude"]
	if !ok {
		t.Fatal("default config missing claude tool")
	}
	if claude.Binary != "claude" {
		t.Fatalf("claude binary = %q, want claude", claude.Binary)
	}
	wantClaudeArgs := []string{"-p", "{{prompt}}", "--output-format", "json", "--permission-mode", "bypassPermissions"}
	if !reflect.DeepEqual(claude.HeadlessArgs, wantClaudeArgs) {
		t.Fatalf("claude headless_args = %v, want %v", claude.HeadlessArgs, wantClaudeArgs)
	}

	if _, ok := cfg.Tools["codex"]; !ok {
		t.Fatal("default config missing codex tool")
	}
	if cfg.Workers.MaxParallel != 3 {
		t.Fatalf("max_parallel = %d, want 3", cfg.Workers.MaxParallel)
	}

	if cfg.Autopilot.Enabled != false {
		t.Fatalf("autopilot.enabled = %v, want false", cfg.Autopilot.Enabled)
	}
	if cfg.Autopilot.EscalateAfterRetries != 2 {
		t.Fatalf("autopilot.escalate_after_retries = %d, want 2", cfg.Autopilot.EscalateAfterRetries)
	}
	if cfg.Autopilot.MaxSprints != 10 {
		t.Fatalf("autopilot.max_sprints = %d, want 10", cfg.Autopilot.MaxSprints)
	}
	if cfg.Autopilot.PauseOnReview != true {
		t.Fatalf("autopilot.pause_on_review = %v, want true", cfg.Autopilot.PauseOnReview)
	}
}

func TestSaveAndLoad(t *testing.T) {
	cfg := Default()
	path := filepath.Join(t.TempDir(), "pod.yaml")

	if err := cfg.Save(path); err != nil {
		t.Fatalf("Save: %v", err)
	}

	loaded, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	assertConfigEquivalent(t, loaded, cfg)
}

func TestLoadInvalid(t *testing.T) {
	if _, err := Load(filepath.Join(t.TempDir(), "does-not-exist.yaml")); err == nil {
		t.Fatal("expected error for nonexistent config path")
	}

	badPath := filepath.Join(t.TempDir(), "bad.yaml")
	if err := os.WriteFile(badPath, []byte("project: ["), 0644); err != nil {
		t.Fatalf("write bad yaml: %v", err)
	}
	if _, err := Load(badPath); err == nil {
		t.Fatal("expected parse error for invalid yaml")
	}
}

func TestSaveAndLoadRoundTrip(t *testing.T) {
	cfg := Default()
	cfg.Project.Name = "roundtrip-project"
	cfg.Tools["echo"] = ToolConfig{
		Binary:       "echo",
		HeadlessArgs: []string{"{{prompt}}"},
		Timeout:      "15s",
	}
	cfg.Autopilot.Enabled = true
	cfg.Autopilot.CostBudget = 12.34
	cfg.Autopilot.EscalateAfterRetries = 5
	cfg.Autopilot.MaxSprints = 7
	cfg.Autopilot.PauseOnReview = false
	cfg.Workers.MaxParallel = 5

	path := filepath.Join(t.TempDir(), "pod.yaml")
	if err := cfg.Save(path); err != nil {
		t.Fatalf("Save: %v", err)
	}

	loaded, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	if loaded.Project.Name != "roundtrip-project" {
		t.Fatalf("project.name = %q, want %q", loaded.Project.Name, "roundtrip-project")
	}
	if _, ok := loaded.Tools["echo"]; !ok {
		t.Fatal("round-trip config missing custom echo tool")
	}
	if loaded.Autopilot.Enabled != true || loaded.Autopilot.CostBudget != 12.34 ||
		loaded.Autopilot.EscalateAfterRetries != 5 || loaded.Autopilot.MaxSprints != 7 || loaded.Autopilot.PauseOnReview != false {
		t.Fatalf("autopilot round-trip mismatch: %+v", loaded.Autopilot)
	}
	if loaded.Workers.MaxParallel != 5 {
		t.Fatalf("workers.max_parallel = %d, want 5", loaded.Workers.MaxParallel)
	}
}
