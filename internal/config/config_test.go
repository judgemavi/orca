package config

import (
	"path/filepath"
	"testing"

	"github.com/jasjeetmavi/orca/internal/state"
	"github.com/jasjeetmavi/orca/internal/toolcfg"
)

func TestResolveToolForPhase(t *testing.T) {
	cfg := Config{
		Tools: []string{"claude", "codex"},
		Orchestrator: OrchestratorConfig{Phases: map[string]PhaseConfig{
			"run": {Tool: "codex"},
		}},
	}
	name, tool, err := cfg.ResolveToolForPhase("run", "")
	if err != nil {
		t.Fatalf("ResolveToolForPhase: %v", err)
	}
	if name != "codex" || tool.Binary != "codex" {
		t.Fatalf("got %q/%q, want codex/codex", name, tool.Binary)
	}
	// Falls back to Tools[0] when no phase config
	name2, _, err := cfg.ResolveToolForPhase("review", "")
	if err != nil {
		t.Fatalf("ResolveToolForPhase fallback: %v", err)
	}
	if name2 != "claude" {
		t.Fatalf("fallback got %q, want claude", name2)
	}
}

func TestResolveModelForPhase(t *testing.T) {
	cfg := Config{
		DefaultTool:  "claude",
		DefaultModel: "claude-sonnet-4-6",
		Orchestrator: OrchestratorConfig{Phases: map[string]PhaseConfig{
			"plan": {Model: "claude-opus-4-6"},
		}},
	}
	if got := cfg.ResolveModelForPhase("plan", "", "claude"); got != "claude-opus-4-6" {
		t.Fatalf("phase model = %q", got)
	}
	// Falls back to first configured model when no phase model override.
	got := cfg.ResolveModelForPhase("review", "", "claude")
	if got != "claude-sonnet-4-6" {
		t.Fatalf("fallback model = %q, want claude-sonnet-4-6", got)
	}
}

func TestValidateDefaults(t *testing.T) {
	tc := &toolcfg.Config{
		Tools: map[string]toolcfg.Tool{
			"claude": {Models: []string{"claude-sonnet-4-6", "claude-opus-4-6"}},
		},
	}
	cfg := Config{DefaultTool: "claude", DefaultModel: "claude-sonnet-4-6"}
	if err := cfg.ValidateDefaults(tc); err != nil {
		t.Fatalf("ValidateDefaults: %v", err)
	}
}

func TestSanitizeOrchestratorReplacesStaleRefs(t *testing.T) {
	tc := &toolcfg.Config{
		Tools: map[string]toolcfg.Tool{
			"claude": {Models: []string{"claude-sonnet-4-6"}},
			"codex":  {Models: []string{"gpt-5.3-codex"}},
		},
	}
	cfg := Config{
		Tools:        []string{"missing-tool", "codex"},
		DefaultTool:  "claude",
		DefaultModel: "claude-sonnet-4-6",
		Orchestrator: OrchestratorConfig{
			SupervisorTool:  "missing-tool",
			SupervisorModel: "missing-model",
			Phases: map[string]PhaseConfig{
				"run": {Tool: "missing-tool", Model: "missing-model"},
			},
		},
	}

	changes := cfg.SanitizeOrchestrator(tc)
	if len(changes) == 0 {
		t.Fatal("expected sanitize changes")
	}
	if cfg.Tools[0] != "codex" {
		t.Fatalf("tools = %v, want [codex]", cfg.Tools)
	}
	if cfg.Orchestrator.SupervisorTool != "claude" {
		t.Fatalf("supervisor tool = %q, want claude", cfg.Orchestrator.SupervisorTool)
	}
	if cfg.Orchestrator.SupervisorModel != "claude-sonnet-4-6" {
		t.Fatalf("supervisor model = %q, want claude-sonnet-4-6", cfg.Orchestrator.SupervisorModel)
	}
	if run := cfg.Orchestrator.Phases["run"]; run.Tool != "claude" || run.Model != "claude-sonnet-4-6" {
		t.Fatalf("run phase = %#v", run)
	}
}

func TestLoadFromDBReturnsDefaultWhenMissing(t *testing.T) {
	db, err := state.Open(filepath.Join(t.TempDir(), "state.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	cfg, err := LoadFromDB(db.DB)
	if err != nil {
		t.Fatalf("LoadFromDB: %v", err)
	}
	if len(cfg.Tools) == 0 || cfg.Tools[0] != "claude" {
		t.Fatalf("tools = %v, want [claude]", cfg.Tools)
	}
}

func TestSaveToDBRoundTrip(t *testing.T) {
	db, err := state.Open(filepath.Join(t.TempDir(), "state.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	cfg, err := Default()
	if err != nil {
		t.Fatalf("Default: %v", err)
	}
	cfg.Project.Name = "orca-test"
	cfg.Tools = []string{"claude", "codex"}
	cfg.Logging.File = ".orca/custom.log"

	if err := cfg.SaveToDB(db.DB); err != nil {
		t.Fatalf("SaveToDB: %v", err)
	}

	loaded, err := LoadFromDB(db.DB)
	if err != nil {
		t.Fatalf("LoadFromDB: %v", err)
	}
	if loaded.Project.Name != "orca-test" {
		t.Fatalf("project.name = %q, want orca-test", loaded.Project.Name)
	}
	if len(loaded.Tools) != 2 || loaded.Tools[1] != "codex" {
		t.Fatalf("tools = %v, want [claude codex]", loaded.Tools)
	}
	if loaded.Logging.File != ".orca/custom.log" {
		t.Fatalf("logging.file = %q, want .orca/custom.log", loaded.Logging.File)
	}
}

func TestUpdateFromDBMergesAndPersists(t *testing.T) {
	db, err := state.Open(filepath.Join(t.TempDir(), "state.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	cfg, err := Default()
	if err != nil {
		t.Fatalf("Default: %v", err)
	}
	if err := cfg.SaveToDB(db.DB); err != nil {
		t.Fatalf("SaveToDB: %v", err)
	}

	updated, err := UpdateFromDB(db.DB, []byte(`{"tools":["claude","codex"],"workers":{"max_parallel":5}}`))
	if err != nil {
		t.Fatalf("UpdateFromDB: %v", err)
	}
	if len(updated.Tools) != 2 || updated.Tools[1] != "codex" {
		t.Fatalf("tools = %v, want [claude codex]", updated.Tools)
	}
	if updated.Workers.MaxParallel != 5 {
		t.Fatalf("workers.max_parallel = %d, want 5", updated.Workers.MaxParallel)
	}

	reloaded, err := LoadFromDB(db.DB)
	if err != nil {
		t.Fatalf("LoadFromDB: %v", err)
	}
	if len(reloaded.Tools) != 2 || reloaded.Tools[1] != "codex" {
		t.Fatalf("reloaded tools = %v, want [claude codex]", reloaded.Tools)
	}
	if reloaded.Workers.MaxParallel != 5 {
		t.Fatalf("reloaded workers.max_parallel = %d, want 5", reloaded.Workers.MaxParallel)
	}
}
