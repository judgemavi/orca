package config

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/jasjeetmavi/orca/internal/task"
	"gopkg.in/yaml.v3"
)

func normalizeSlice(v []string) []string {
	if v == nil {
		return []string{}
	}
	return v
}

func normalizePhases(m map[string]PhaseConfig) map[string]PhaseConfig {
	if len(m) == 0 {
		return map[string]PhaseConfig{}
	}
	return m
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
		!reflect.DeepEqual(normalizePhases(got.Orchestrator.Phases), normalizePhases(want.Orchestrator.Phases)) {
		t.Fatalf("orchestrator mismatch: got=%+v want=%+v", got.Orchestrator, want.Orchestrator)
	}
	if got.Monitor != want.Monitor {
		t.Fatalf("monitor mismatch: got=%+v want=%+v", got.Monitor, want.Monitor)
	}
	if got.Quality != want.Quality {
		t.Fatalf("quality mismatch: got=%+v want=%+v", got.Quality, want.Quality)
	}
	if got.Cleanup != want.Cleanup {
		t.Fatalf("cleanup mismatch: got=%+v want=%+v", got.Cleanup, want.Cleanup)
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
			gotTool.Output != wantTool.Output ||
			gotTool.Cost != wantTool.Cost ||
			!reflect.DeepEqual(normalizeSlice(gotTool.Models), normalizeSlice(wantTool.Models)) ||
			!reflect.DeepEqual(normalizeSlice(gotTool.InteractiveArgs), normalizeSlice(wantTool.InteractiveArgs)) ||
			!reflect.DeepEqual(normalizeSlice(gotTool.HeadlessArgs), normalizeSlice(wantTool.HeadlessArgs)) ||
			!reflect.DeepEqual(normalizeSlice(gotTool.ResumeArgs), normalizeSlice(wantTool.ResumeArgs)) ||
			gotTool.SessionIDPattern != wantTool.SessionIDPattern {
			t.Fatalf("tool %q mismatch: got=%+v want=%+v", name, gotTool, wantTool)
		}
	}
}

func TestDefault(t *testing.T) {
	cfg, err := Default()
	if err != nil {
		t.Fatalf("Default: %v", err)
	}

	if cfg.Project.IntegrationBranch != "orca/integration" {
		t.Fatalf("integration_branch = %q, want %q", cfg.Project.IntegrationBranch, "orca/integration")
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
	wantClaudeInteractive := []string{"--mcp-config", "{{mcp_config}}", "--allowedTools", "{{allowed_tools}}", "--append-system-prompt", "{{context}}"}
	if !reflect.DeepEqual(claude.InteractiveArgs, wantClaudeInteractive) {
		t.Fatalf("claude interactive_args = %v, want %v", claude.InteractiveArgs, wantClaudeInteractive)
	}
	wantClaudeModels := []string{"claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5-20251001", "claude-opus-4-5-20251101", "claude-sonnet-4-5-20250929"}
	if !reflect.DeepEqual(claude.Models, wantClaudeModels) {
		t.Fatalf("claude models = %v, want %v", claude.Models, wantClaudeModels)
	}
	if claude.Output.Mode != "json_envelope" || claude.Output.ResultField != "result" {
		t.Fatalf("claude output config mismatch: %+v", claude.Output)
	}
	if claude.Cost.Mode != "json_field" ||
		claude.Cost.CostField != "total_cost_usd" ||
		claude.Cost.UsageInput != "usage.input_tokens" ||
		claude.Cost.UsageOutput != "usage.output_tokens" {
		t.Fatalf("claude cost config mismatch: %+v", claude.Cost)
	}

	codex, ok := cfg.Tools["codex"]
	if !ok {
		t.Fatal("default config missing codex tool")
	}
	wantCodexModels := []string{"gpt-5.3-codex", "gpt-5.2-codex", "gpt-5.1-codex-max", "gpt-5.1-codex", "gpt-5-codex", "gpt-5-codex-mini"}
	if !reflect.DeepEqual(codex.Models, wantCodexModels) {
		t.Fatalf("codex models = %v, want %v", codex.Models, wantCodexModels)
	}
	if codex.Output.Mode != "stdout" {
		t.Fatalf("codex output.mode = %q, want stdout", codex.Output.Mode)
	}
	if codex.Cost.Mode != "none" {
		t.Fatalf("codex cost.mode = %q, want none", codex.Cost.Mode)
	}
	wantCodexInteractive := []string{"-a", "never", "{{context}}"}
	if !reflect.DeepEqual(codex.InteractiveArgs, wantCodexInteractive) {
		t.Fatalf("codex interactive_args = %v, want %v", codex.InteractiveArgs, wantCodexInteractive)
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
	if cfg.Monitor.StuckCheckInterval != "30s" ||
		cfg.Monitor.MaxStuckCycles != 3 ||
		cfg.Monitor.ConflictInterval != "15s" ||
		cfg.Monitor.TaskBudget != 0 {
		t.Fatalf("monitor defaults mismatch: %+v", cfg.Monitor)
	}
	if cfg.Quality.Enabled != true ||
		cfg.Quality.ScopeCheck != true ||
		cfg.Quality.TestDelta != true ||
		cfg.Quality.AlignmentCheck != false {
		t.Fatalf("quality defaults mismatch: %+v", cfg.Quality)
	}
	if cfg.Cleanup.TTL != "168h" {
		t.Fatalf("cleanup.ttl = %q, want 168h", cfg.Cleanup.TTL)
	}
}

func TestSaveAndLoad(t *testing.T) {
	cfg, err := Default()
	if err != nil {
		t.Fatalf("Default: %v", err)
	}
	path := filepath.Join(t.TempDir(), "orca.yaml")

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

func TestConfigValidate(t *testing.T) {
	newDefault := func(t *testing.T) Config {
		t.Helper()
		cfg, err := Default()
		if err != nil {
			t.Fatalf("Default: %v", err)
		}
		return cfg
	}

	t.Run("valid config passes", func(t *testing.T) {
		cfg := newDefault(t)
		if err := cfg.Validate(); err != nil {
			t.Fatalf("Validate: %v", err)
		}
	})

	t.Run("max parallel zero fails", func(t *testing.T) {
		cfg := newDefault(t)
		cfg.Workers.MaxParallel = 0

		err := cfg.Validate()
		if err == nil {
			t.Fatal("expected validation error")
		}
		if !strings.Contains(err.Error(), "workers.max_parallel") {
			t.Fatalf("unexpected error: %v", err)
		}
	})

	t.Run("invalid timeout fails", func(t *testing.T) {
		cfg := newDefault(t)
		tool := cfg.Defaults.Tool
		if tool == "" {
			tool = "claude"
		}
		toolCfg := cfg.Tools[tool]
		toolCfg.Timeout = "definitely-not-duration"
		cfg.Tools[tool] = toolCfg

		err := cfg.Validate()
		if err == nil {
			t.Fatal("expected validation error")
		}
		if !strings.Contains(err.Error(), "timeout") {
			t.Fatalf("unexpected error: %v", err)
		}
	})

	t.Run("negative budget fails", func(t *testing.T) {
		cfg := newDefault(t)
		cfg.Orchestrator.CostBudget = -1

		err := cfg.Validate()
		if err == nil {
			t.Fatal("expected validation error")
		}
		if !strings.Contains(err.Error(), "orchestrator.cost_budget") {
			t.Fatalf("unexpected error: %v", err)
		}
	})

	t.Run("unknown supervisor tool fails", func(t *testing.T) {
		cfg := newDefault(t)
		cfg.Orchestrator.SupervisorTool = "missing-tool"

		err := cfg.Validate()
		if err == nil {
			t.Fatal("expected validation error")
		}
		if !strings.Contains(err.Error(), "orchestrator.supervisor_tool") {
			t.Fatalf("unexpected error: %v", err)
		}
	})
}

func TestLoadRunsValidation(t *testing.T) {
	cfg, err := Default()
	if err != nil {
		t.Fatalf("Default: %v", err)
	}
	cfg.Workers.MaxParallel = 0

	path := filepath.Join(t.TempDir(), "orca.yaml")
	if err := cfg.Save(path); err != nil {
		t.Fatalf("Save: %v", err)
	}

	_, err = Load(path)
	if err == nil {
		t.Fatal("expected validation error from Load")
	}
	if !strings.Contains(err.Error(), "validate config") || !strings.Contains(err.Error(), "workers.max_parallel") {
		t.Fatalf("unexpected error: %v", err)
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
	cfg.Monitor = MonitorConfig{
		StuckCheckInterval: "45s",
		MaxStuckCycles:     5,
		ConflictInterval:   "20s",
		TaskBudget:         1.25,
	}
	cfg.Quality = QualityConfig{
		Enabled:        true,
		ScopeCheck:     false,
		TestDelta:      true,
		AlignmentCheck: true,
	}
	cfg.Cleanup = CleanupConfig{
		TTL: "72h",
	}

	path := filepath.Join(t.TempDir(), "orca.yaml")
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
	if loaded.Monitor != cfg.Monitor {
		t.Fatalf("monitor mismatch: got=%+v want=%+v", loaded.Monitor, cfg.Monitor)
	}
	if loaded.Quality != cfg.Quality {
		t.Fatalf("quality mismatch: got=%+v want=%+v", loaded.Quality, cfg.Quality)
	}
	if loaded.Cleanup != cfg.Cleanup {
		t.Fatalf("cleanup mismatch: got=%+v want=%+v", loaded.Cleanup, cfg.Cleanup)
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

	for _, phase := range []string{"explore", "plan", "sprint", "review", "merge"} {
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
	if toolCfg.Output.Mode != "stdout" {
		t.Fatalf("legacy tool output.mode=%q, want stdout", toolCfg.Output.Mode)
	}
	if toolCfg.Cost.Mode != "none" {
		t.Fatalf("legacy tool cost.mode=%q, want none", toolCfg.Cost.Mode)
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
	if cfg.Monitor.StuckCheckInterval != "30s" {
		t.Fatalf("monitor.stuck_check_interval = %q, want 30s", cfg.Monitor.StuckCheckInterval)
	}
	if cfg.Monitor.MaxStuckCycles != 3 {
		t.Fatalf("monitor.max_stuck_cycles = %d, want 3", cfg.Monitor.MaxStuckCycles)
	}
	if cfg.Monitor.ConflictInterval != "15s" {
		t.Fatalf("monitor.conflict_check_interval = %q, want 15s", cfg.Monitor.ConflictInterval)
	}
	if cfg.Quality.Enabled != true || cfg.Quality.ScopeCheck != true || cfg.Quality.TestDelta != true || cfg.Quality.AlignmentCheck != false {
		t.Fatalf("quality defaults mismatch: %+v", cfg.Quality)
	}
	if cfg.Cleanup.TTL != "168h" {
		t.Fatalf("cleanup.ttl = %q, want 168h", cfg.Cleanup.TTL)
	}
}

func TestConfigYAML_NewFieldsParse(t *testing.T) {
	data := []byte(`
project:
  name: parse-project
  integration_branch: main
  worktree_dir: .worktrees
tools:
  codex:
    binary: codex
    model: gpt-5-codex
    timeout: 30m
    mode: headless
    prompt_mode: arg
    output:
      mode: file
      result_path: "{{worktree}}/.orca/result.md"
    cost:
      mode: regex
      pattern: 'input=(\d+)\s+output=(\d+)\s+cost=([0-9.]+)'
validation:
  commands: []
workers:
  max_parallel: 2
orchestrator:
  cost_budget: 0
monitor:
  stuck_check_interval: 22s
  max_stuck_cycles: 7
  conflict_check_interval: 9s
  task_budget: 4.5
quality:
  enabled: false
  scope_check: true
  test_delta: false
  alignment_check: true
cleanup:
  ttl: 24h
`)

	var cfg Config
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		t.Fatalf("yaml.Unmarshal: %v", err)
	}
	if cfg.Monitor.StuckCheckInterval != "22s" ||
		cfg.Monitor.MaxStuckCycles != 7 ||
		cfg.Monitor.ConflictInterval != "9s" ||
		cfg.Monitor.TaskBudget != 4.5 {
		t.Fatalf("monitor parse mismatch: %+v", cfg.Monitor)
	}
	if cfg.Quality.Enabled != false ||
		cfg.Quality.ScopeCheck != true ||
		cfg.Quality.TestDelta != false ||
		cfg.Quality.AlignmentCheck != true {
		t.Fatalf("quality parse mismatch: %+v", cfg.Quality)
	}
	if cfg.Cleanup.TTL != "24h" {
		t.Fatalf("cleanup.ttl = %q, want 24h", cfg.Cleanup.TTL)
	}
	tool := cfg.Tools["codex"]
	if tool.Output.Mode != "file" || tool.Output.ResultPath != "{{worktree}}/.orca/result.md" {
		t.Fatalf("output parse mismatch: %+v", tool.Output)
	}
	if tool.Cost.Mode != "regex" || tool.Cost.Pattern != `input=(\d+)\s+output=(\d+)\s+cost=([0-9.]+)` {
		t.Fatalf("cost parse mismatch: %+v", tool.Cost)
	}
}

func TestLoadAppliesNewFieldDefaultsWhenOmitted(t *testing.T) {
	path := filepath.Join(t.TempDir(), "orca.yaml")
	data := []byte(`
project:
  name: defaults-project
  integration_branch: main
  worktree_dir: .worktrees
tools:
  codex:
    binary: codex
    model: gpt-5-codex
    timeout: 30m
    mode: headless
    prompt_mode: arg
validation:
  commands: []
workers:
  max_parallel: 1
orchestrator:
  cost_budget: 0
`)
	if err := os.WriteFile(path, data, 0644); err != nil {
		t.Fatalf("write config: %v", err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	if cfg.Monitor.StuckCheckInterval != "30s" ||
		cfg.Monitor.MaxStuckCycles != 3 ||
		cfg.Monitor.ConflictInterval != "15s" ||
		cfg.Monitor.TaskBudget != 0 {
		t.Fatalf("monitor defaults not applied: %+v", cfg.Monitor)
	}
	if cfg.Quality.Enabled != true ||
		cfg.Quality.ScopeCheck != true ||
		cfg.Quality.TestDelta != true ||
		cfg.Quality.AlignmentCheck != false {
		t.Fatalf("quality defaults not applied: %+v", cfg.Quality)
	}
	if cfg.Cleanup.TTL != "168h" {
		t.Fatalf("cleanup default not applied: got %q want 168h", cfg.Cleanup.TTL)
	}
	if cfg.Tools["codex"].Output.Mode != "stdout" {
		t.Fatalf("tool output default not applied: %+v", cfg.Tools["codex"].Output)
	}
	if cfg.Tools["codex"].Cost.Mode != "none" {
		t.Fatalf("tool cost default not applied: %+v", cfg.Tools["codex"].Cost)
	}
}

func TestLoadWithAllNewFields(t *testing.T) {
	path := filepath.Join(t.TempDir(), "orca.yaml")
	data := []byte(`
project:
  name: all-fields-project
  integration_branch: main
  worktree_dir: .worktrees
tools:
  codex:
    binary: codex
    model: gpt-5-codex
    timeout: 30m
    mode: headless
    prompt_mode: arg
    output:
      mode: regex
      pattern: '(?s)RESULT:\s*(.+)$'
    cost:
      mode: json_field
      cost_field: billing.total_cost_usd
      usage_input: usage.in_tokens
      usage_output: usage.out_tokens
validation:
  commands: []
workers:
  max_parallel: 1
orchestrator:
  cost_budget: 0
monitor:
  stuck_check_interval: 40s
  max_stuck_cycles: 6
  conflict_check_interval: 12s
  task_budget: 2.75
quality:
  enabled: false
  scope_check: false
  test_delta: true
  alignment_check: true
cleanup:
  ttl: 200h
`)
	if err := os.WriteFile(path, data, 0644); err != nil {
		t.Fatalf("write config: %v", err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	if cfg.Monitor.StuckCheckInterval != "40s" ||
		cfg.Monitor.MaxStuckCycles != 6 ||
		cfg.Monitor.ConflictInterval != "12s" ||
		cfg.Monitor.TaskBudget != 2.75 {
		t.Fatalf("monitor load mismatch: %+v", cfg.Monitor)
	}
	if cfg.Quality.Enabled != false ||
		cfg.Quality.ScopeCheck != false ||
		cfg.Quality.TestDelta != true ||
		cfg.Quality.AlignmentCheck != true {
		t.Fatalf("quality load mismatch: %+v", cfg.Quality)
	}
	if cfg.Cleanup.TTL != "200h" {
		t.Fatalf("cleanup.ttl = %q, want 200h", cfg.Cleanup.TTL)
	}
	tool := cfg.Tools["codex"]
	if tool.Output.Mode != "regex" || tool.Output.Pattern != `(?s)RESULT:\s*(.+)$` {
		t.Fatalf("tool output mismatch: %+v", tool.Output)
	}
	if tool.Cost.Mode != "json_field" ||
		tool.Cost.CostField != "billing.total_cost_usd" ||
		tool.Cost.UsageInput != "usage.in_tokens" ||
		tool.Cost.UsageOutput != "usage.out_tokens" {
		t.Fatalf("tool cost mismatch: %+v", tool.Cost)
	}
}

func TestToolConfigDefaults_EmptyOutputCostBlocks(t *testing.T) {
	data := []byte(`
project:
  integration_branch: main
  worktree_dir: .worktrees
tools:
  custom:
    binary: custom
    timeout: 30s
    mode: headless
    prompt_mode: arg
    output: {}
    cost: {}
workers:
  max_parallel: 1
validation:
  commands: []
orchestrator:
  cost_budget: 0
`)

	var cfg Config
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		t.Fatalf("yaml.Unmarshal: %v", err)
	}

	tool := cfg.Tools["custom"]
	if tool.Output.Mode != "stdout" {
		t.Fatalf("output.mode=%q, want stdout", tool.Output.Mode)
	}
	if tool.Cost.Mode != "none" {
		t.Fatalf("cost.mode=%q, want none", tool.Cost.Mode)
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

func TestResolveToolForPhase_Priority(t *testing.T) {
	cfg := Config{
		Tools: map[string]ToolConfig{
			"codex":  {Binary: "codex", Model: "codex-default", Models: []string{"codex-default", "codex-allowed"}},
			"claude": {Binary: "claude", Model: "claude-default", Models: []string{"claude-default", "claude-allowed"}},
		},
		Defaults: DefaultsConfig{Tool: "claude", Model: "claude-default"},
		Orchestrator: OrchestratorConfig{
			Phases: map[string]PhaseConfig{
				"plan": {Tool: "claude", Model: "claude-default"},
			},
		},
	}
	tk := &task.Task{
		AssignedTool: "claude",
		Model:        "claude-allowed",
		PhaseConfig: &task.PhaseConfigMap{
			Phases: map[string]task.PhaseOverride{
				"plan": {Tool: "codex", Model: "codex-allowed"},
			},
		},
	}

	name, tc, err := cfg.ResolveToolForPhase(tk, "plan", "")
	if err != nil {
		t.Fatalf("ResolveToolForPhase: %v", err)
	}
	if name != "codex" {
		t.Fatalf("tool=%q, want codex", name)
	}
	if tc.Model != "codex-allowed" {
		t.Fatalf("model=%q, want codex-allowed", tc.Model)
	}
}

func TestResolveToolForPhase_Override(t *testing.T) {
	cfg := Config{
		Tools: map[string]ToolConfig{
			"codex":  {Binary: "codex", Model: "codex-default", Models: []string{"codex-default", "codex-allowed"}},
			"claude": {Binary: "claude", Model: "claude-default", Models: []string{"claude-default", "claude-allowed"}},
		},
		Defaults: DefaultsConfig{Tool: "claude", Model: "claude-default"},
		Orchestrator: OrchestratorConfig{
			Phases: map[string]PhaseConfig{
				"plan": {Tool: "claude", Model: "claude-default"},
			},
		},
	}
	tk := &task.Task{
		Model: "claude-allowed",
		PhaseConfig: &task.PhaseConfigMap{
			Phases: map[string]task.PhaseOverride{
				"plan": {Tool: "codex", Model: "codex-allowed"},
			},
		},
	}

	name, tc, err := cfg.ResolveToolForPhase(tk, "plan", "claude")
	if err != nil {
		t.Fatalf("ResolveToolForPhase: %v", err)
	}
	if name != "claude" {
		t.Fatalf("tool=%q, want claude", name)
	}
	if tc.Model != "claude-allowed" {
		t.Fatalf("model=%q, want claude-allowed", tc.Model)
	}
}

func TestValidateModel(t *testing.T) {
	tc := ToolConfig{
		Binary: "codex",
		Models: []string{"m1", "m2"},
	}
	if got := ValidateModel("codex", "m2", tc); got != "m2" {
		t.Fatalf("ValidateModel valid=%q, want m2", got)
	}
	if got := ValidateModel("codex", "missing", tc); got != "" {
		t.Fatalf("ValidateModel invalid=%q, want empty", got)
	}
}
