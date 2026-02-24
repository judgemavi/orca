package config

import (
	"path/filepath"
	"testing"

	"github.com/jasjeetmavi/orca/internal/driver"
	"github.com/jasjeetmavi/orca/internal/state"
)

func TestResolveToolForPhase(t *testing.T) {
	cfg := Config{
		Tools:    []string{"claude", "codex"},
		Defaults: DefaultsConfig{Tool: "claude"},
		Orchestrator: OrchestratorConfig{Phases: map[string]PhaseConfig{
			"run": {Tool: "codex"},
		}},
	}
	name, d, err := cfg.ResolveToolForPhase("run", "")
	if err != nil {
		t.Fatalf("ResolveToolForPhase: %v", err)
	}
	if name != "codex" || d.Name() != "codex" {
		t.Fatalf("got %q/%q, want codex", name, d.Name())
	}
}

func TestResolveModelForPhase(t *testing.T) {
	cfg := Config{
		Defaults: DefaultsConfig{Model: "claude-sonnet-4-6"},
		Orchestrator: OrchestratorConfig{Phases: map[string]PhaseConfig{
			"plan": {Model: "claude-opus-4-6"},
		}},
	}
	d, _ := driver.Get("claude")
	if got := cfg.ResolveModelForPhase("plan", "", d); got != "claude-opus-4-6" {
		t.Fatalf("phase model = %q", got)
	}
	if got := cfg.ResolveModelForPhase("review", "", d); got != "claude-sonnet-4-6" {
		t.Fatalf("default model = %q", got)
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
	if cfg.Defaults.Tool != "claude" {
		t.Fatalf("defaults.tool = %q, want claude", cfg.Defaults.Tool)
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
	cfg.Defaults.Tool = "codex"
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
	if loaded.Defaults.Tool != "codex" {
		t.Fatalf("defaults.tool = %q, want codex", loaded.Defaults.Tool)
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

	updated, err := UpdateFromDB(db.DB, []byte(`{"defaults":{"tool":"codex"},"workers":{"max_parallel":5}}`))
	if err != nil {
		t.Fatalf("UpdateFromDB: %v", err)
	}
	if updated.Defaults.Tool != "codex" {
		t.Fatalf("defaults.tool = %q, want codex", updated.Defaults.Tool)
	}
	if updated.Workers.MaxParallel != 5 {
		t.Fatalf("workers.max_parallel = %d, want 5", updated.Workers.MaxParallel)
	}

	reloaded, err := LoadFromDB(db.DB)
	if err != nil {
		t.Fatalf("LoadFromDB: %v", err)
	}
	if reloaded.Defaults.Tool != "codex" {
		t.Fatalf("reloaded defaults.tool = %q, want codex", reloaded.Defaults.Tool)
	}
	if reloaded.Workers.MaxParallel != 5 {
		t.Fatalf("reloaded workers.max_parallel = %d, want 5", reloaded.Workers.MaxParallel)
	}
}
