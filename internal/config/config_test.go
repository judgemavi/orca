package config

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"gopkg.in/yaml.v3"
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
	if got.Defaults != want.Defaults {
		t.Fatalf("defaults mismatch: got=%+v want=%+v", got.Defaults, want.Defaults)
	}
	if !reflect.DeepEqual(normalizeSlice(got.Validation.Commands), normalizeSlice(want.Validation.Commands)) {
		t.Fatalf("validation commands mismatch: got=%v want=%v", got.Validation.Commands, want.Validation.Commands)
	}
	if got.Orchestrator.CostBudget != want.Orchestrator.CostBudget ||
		got.Orchestrator.SupervisorTool != want.Orchestrator.SupervisorTool ||
		got.Orchestrator.SupervisorModel != want.Orchestrator.SupervisorModel ||
		!reflect.DeepEqual(got.Orchestrator.Phases, want.Orchestrator.Phases) {
		t.Fatalf("orchestrator mismatch: got=%+v want=%+v", got.Orchestrator, want.Orchestrator)
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
			gotTool.Model != wantTool.Model ||
			gotTool.Timeout != wantTool.Timeout ||
			gotTool.Mode != wantTool.Mode ||
			gotTool.PromptMode != wantTool.PromptMode ||
			!reflect.DeepEqual(normalizeSlice(gotTool.Models), normalizeSlice(wantTool.Models)) ||
			!reflect.DeepEqual(normalizeSlice(gotTool.InteractiveArgs), normalizeSlice(wantTool.InteractiveArgs)) ||
			!reflect.DeepEqual(normalizeSlice(gotTool.HeadlessArgs), normalizeSlice(wantTool.HeadlessArgs)) {
			t.Fatalf("tool %q mismatch: got=%+v want=%+v", name, gotTool, wantTool)
		}
	}
}

func TestDefault(t *testing.T) {
	cfg, err := Default()
	if err != nil {
		t.Fatalf("Default: %v", err)
	}

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
	wantClaudeModels := []string{"claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5-20251001", "claude-opus-4-5-20251101", "claude-sonnet-4-5-20250929"}
	if !reflect.DeepEqual(claude.Models, wantClaudeModels) {
		t.Fatalf("claude models = %v, want %v", claude.Models, wantClaudeModels)
	}

	codex, ok := cfg.Tools["codex"]
	if !ok {
		t.Fatal("default config missing codex tool")
	}
	wantCodexModels := []string{"gpt-5.3-codex", "gpt-5.2-codex", "gpt-5.1-codex-max", "gpt-5.1-codex", "gpt-5-codex", "gpt-5-codex-mini"}
	if !reflect.DeepEqual(codex.Models, wantCodexModels) {
		t.Fatalf("codex models = %v, want %v", codex.Models, wantCodexModels)
	}

	if _, ok := cfg.Tools["aider"]; ok {
		t.Fatal("default config should not include aider")
	}
	if cfg.Workers.MaxParallel != 3 {
		t.Fatalf("max_parallel = %d, want 3", cfg.Workers.MaxParallel)
	}

	if cfg.Orchestrator.CostBudget != 0 {
		t.Fatalf("orchestrator.cost_budget = %v, want 0", cfg.Orchestrator.CostBudget)
	}
	if cfg.Orchestrator.SupervisorTool != "claude" {
		t.Fatalf("orchestrator.supervisor_tool = %q, want claude", cfg.Orchestrator.SupervisorTool)
	}
	if cfg.Defaults.Tool != "claude" {
		t.Fatalf("defaults.tool = %q, want claude", cfg.Defaults.Tool)
	}
}

func TestSaveAndLoad(t *testing.T) {
	cfg, err := Default()
	if err != nil {
		t.Fatalf("Default: %v", err)
	}
	path := filepath.Join(t.TempDir(), "pod.yaml")

	if err := cfg.Save(path); err != nil {
		t.Fatalf("Save: %v", err)
	}

	loaded, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	if cfg.Project.WorktreeDir != "" && !filepath.IsAbs(cfg.Project.WorktreeDir) {
		cfg.Project.WorktreeDir = filepath.Join(filepath.Dir(path), "..", cfg.Project.WorktreeDir)
	}

	assertConfigEquivalent(t, loaded, &cfg)
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
	cfg, err := Default()
	if err != nil {
		t.Fatalf("Default: %v", err)
	}
	cfg.Project.Name = "roundtrip-project"
	cfg.Tools["echo"] = ToolConfig{
		Binary:       "echo",
		Model:        "echo-1",
		Models:       []string{"echo-model-1"},
		HeadlessArgs: []string{"{{prompt}}"},
		Timeout:      "15s",
	}
	cfg.Orchestrator.CostBudget = 12.34
	cfg.Orchestrator.SupervisorTool = "claude"
	cfg.Orchestrator.SupervisorModel = "claude-opus-4-6"
	cfg.Orchestrator.Phases = map[string]PhaseConfig{
		"explore": {Tool: "codex", Model: "gpt-5-codex"},
	}
	cfg.Defaults = DefaultsConfig{Tool: "claude", Model: "claude-sonnet-4-6"}
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
	if loaded.Orchestrator.CostBudget != 12.34 || loaded.Orchestrator.SupervisorTool != "claude" || loaded.Orchestrator.SupervisorModel != "claude-opus-4-6" {
		t.Fatalf("orchestrator round-trip mismatch: %+v", loaded.Orchestrator)
	}
	if !reflect.DeepEqual(loaded.Orchestrator.Phases, cfg.Orchestrator.Phases) {
		t.Fatalf("orchestrator phases mismatch: got=%+v want=%+v", loaded.Orchestrator.Phases, cfg.Orchestrator.Phases)
	}
	if loaded.Defaults != cfg.Defaults {
		t.Fatalf("defaults mismatch: got=%+v want=%+v", loaded.Defaults, cfg.Defaults)
	}
	if loaded.Workers.MaxParallel != 5 {
		t.Fatalf("workers.max_parallel = %d, want 5", loaded.Workers.MaxParallel)
	}
}

func TestResolvePhaseToolConfig_PhaseOverride(t *testing.T) {
	cfg := Config{
		Tools: map[string]ToolConfig{
			"claude": {Binary: "claude", Model: "claude-base"},
			"codex":  {Binary: "codex", Model: "codex-base"},
		},
		Defaults: DefaultsConfig{
			Tool:  "claude",
			Model: "default-model",
		},
		Orchestrator: OrchestratorConfig{
			Phases: map[string]PhaseConfig{
				"explore": {Tool: "codex"},
			},
		},
	}

	cases := []struct {
		phase     string
		wantTool  string
		wantModel string
	}{
		{phase: "explore", wantTool: "codex", wantModel: "default-model"},
		{phase: "plan", wantTool: "claude", wantModel: "default-model"},
		{phase: "review", wantTool: "claude", wantModel: "default-model"},
	}

	for _, tc := range cases {
		gotTool, gotCfg, err := cfg.ResolvePhaseToolConfig(tc.phase)
		if err != nil {
			t.Fatalf("ResolvePhaseToolConfig(%q): %v", tc.phase, err)
		}
		if gotTool != tc.wantTool {
			t.Fatalf("ResolvePhaseToolConfig(%q) tool=%q, want %q", tc.phase, gotTool, tc.wantTool)
		}
		if gotCfg.Model != tc.wantModel {
			t.Fatalf("ResolvePhaseToolConfig(%q) model=%q, want %q", tc.phase, gotCfg.Model, tc.wantModel)
		}
	}
}

func TestResolvePhaseToolConfig_DefaultsFallback(t *testing.T) {
	cfg := Config{
		Tools: map[string]ToolConfig{
			"claude": {Binary: "claude", Model: "claude-model"},
			"codex":  {Binary: "codex", Model: "codex-model"},
		},
		Defaults: DefaultsConfig{Tool: "codex"},
	}

	for _, phase := range []string{"explore", "plan", "sprint", "review", "integrate"} {
		toolName, _, err := cfg.ResolvePhaseToolConfig(phase)
		if err != nil {
			t.Fatalf("ResolvePhaseToolConfig(%q): %v", phase, err)
		}
		if toolName != "codex" {
			t.Fatalf("ResolvePhaseToolConfig(%q) tool=%q, want codex", phase, toolName)
		}
	}
}

func TestResolvePhaseToolConfig_FirstToolFallback(t *testing.T) {
	cfg := Config{
		Tools: map[string]ToolConfig{
			"zulu":  {Binary: "zulu", Model: "zulu-model"},
			"alpha": {Binary: "alpha", Model: "alpha-model"},
		},
	}

	toolName, toolCfg, err := cfg.ResolvePhaseToolConfig("explore")
	if err != nil {
		t.Fatalf("ResolvePhaseToolConfig: %v", err)
	}
	if toolName != "alpha" {
		t.Fatalf("tool=%q, want alpha", toolName)
	}
	if toolCfg.Model != "alpha-model" {
		t.Fatalf("model=%q, want alpha-model", toolCfg.Model)
	}
}

func TestResolvePhaseToolConfig_ModelResolution(t *testing.T) {
	cfg := Config{
		Tools: map[string]ToolConfig{
			"claude": {Binary: "claude", Model: "tool-model"},
		},
		Defaults: DefaultsConfig{Tool: "claude", Model: "default-model"},
		Orchestrator: OrchestratorConfig{
			Phases: map[string]PhaseConfig{
				"explore": {Model: "phase-model"},
				"plan":    {},
				"review":  {},
			},
		},
	}

	_, exploreCfg, err := cfg.ResolvePhaseToolConfig("explore")
	if err != nil {
		t.Fatalf("ResolvePhaseToolConfig(explore): %v", err)
	}
	if exploreCfg.Model != "phase-model" {
		t.Fatalf("explore model=%q, want phase-model", exploreCfg.Model)
	}

	_, planCfg, err := cfg.ResolvePhaseToolConfig("plan")
	if err != nil {
		t.Fatalf("ResolvePhaseToolConfig(plan): %v", err)
	}
	if planCfg.Model != "default-model" {
		t.Fatalf("plan model=%q, want default-model", planCfg.Model)
	}

	cfg.Defaults.Model = ""
	_, reviewCfg, err := cfg.ResolvePhaseToolConfig("review")
	if err != nil {
		t.Fatalf("ResolvePhaseToolConfig(review): %v", err)
	}
	if reviewCfg.Model != "tool-model" {
		t.Fatalf("review model=%q, want tool-model", reviewCfg.Model)
	}
}

func TestResolvePhaseToolConfig_InvalidTool(t *testing.T) {
	cfg := Config{
		Tools: map[string]ToolConfig{
			"claude": {Binary: "claude", Model: "claude-model"},
		},
		Orchestrator: OrchestratorConfig{
			Phases: map[string]PhaseConfig{
				"review": {Tool: "codex"},
			},
		},
	}

	if _, _, err := cfg.ResolvePhaseToolConfig("review"); err == nil {
		t.Fatal("expected error for unknown phase tool")
	}
}

func TestBackwardCompat_NoNewFields(t *testing.T) {
	data := []byte(`
project:
  name: legacy-project
  integration_branch: main
  worktree_dir: .worktrees
tools:
  zulu:
    binary: zulu
    model: zulu-model
    timeout: 30m
    mode: cli
    prompt_mode: inline
  alpha:
    binary: alpha
    model: alpha-model
    timeout: 30m
    mode: cli
    prompt_mode: inline
validation:
  commands: []
workers:
  max_parallel: 2
orchestrator:
  cost_budget: 0
`)

	var cfg Config
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		t.Fatalf("yaml.Unmarshal legacy config: %v", err)
	}

	toolName, toolCfg, err := cfg.ResolvePhaseToolConfig("explore")
	if err != nil {
		t.Fatalf("ResolvePhaseToolConfig: %v", err)
	}
	if toolName != "alpha" {
		t.Fatalf("tool=%q, want alpha", toolName)
	}
	if toolCfg.Model != "alpha-model" {
		t.Fatalf("model=%q, want alpha-model", toolCfg.Model)
	}
}

func TestDefaultsYAML_NewFields(t *testing.T) {
	cfg, err := Default()
	if err != nil {
		t.Fatalf("Default: %v", err)
	}

	if cfg.Orchestrator.SupervisorTool != "claude" {
		t.Fatalf("orchestrator.supervisor_tool = %q, want claude", cfg.Orchestrator.SupervisorTool)
	}
	if cfg.Defaults.Tool != "claude" {
		t.Fatalf("defaults.tool = %q, want claude", cfg.Defaults.Tool)
	}
}

func TestResolvePhaseToolConfig_InvalidDefaultTool(t *testing.T) {
	cfg := Config{
		Tools: map[string]ToolConfig{
			"claude": {Binary: "claude", Model: "claude-model"},
		},
		Defaults: DefaultsConfig{Tool: "codex"},
	}

	if _, _, err := cfg.ResolvePhaseToolConfig("review"); err == nil {
		t.Fatal("expected error for unknown default tool")
	}
}

func TestResolvePhaseToolConfig_NoToolsConfigured(t *testing.T) {
	cfg := Config{}
	if _, _, err := cfg.ResolvePhaseToolConfig("explore"); err == nil {
		t.Fatal("expected error for no tools configured")
	}
}
