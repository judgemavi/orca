package config

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

const testToolConfigJSON = `{
  "tools": {
    "codex": {
      "binary": "codex-test",
      "models": ["gpt-5.3-codex"],
      "args": [
        { "param": "--prompt", "variable": "prompt", "used_in": ["headless"] },
        { "param": "--prompt", "variable": "context", "used_in": ["interactive"] },
        { "param": "--resume", "variable": "session_id", "used_in": ["resume"] },
        { "param": "--prompt", "variable": "feedback", "used_in": ["resume"] }
      ],
      "session_id": { "mode": "json", "key": "thread_id" },
      "timeout": "600s"
    }
  }
}`

func withLookPathStub(t *testing.T, fn func(string) (string, error)) {
	t.Helper()
	orig := lookPath
	lookPath = fn
	t.Cleanup(func() {
		lookPath = orig
	})
}

func TestEnsureDefaultToolConfigWritesAndLoads(t *testing.T) {
	repoDir := t.TempDir()
	setToolConfig(nil, "")
	t.Cleanup(func() { setToolConfig(nil, "") })
	withLookPathStub(t, func(bin string) (string, error) { return "/usr/bin/" + bin, nil })

	path, err := EnsureDefaultToolConfig(repoDir)
	if err != nil {
		t.Fatalf("EnsureDefaultToolConfig: %v", err)
	}
	wantPath := filepath.Join(repoDir, DefaultToolsConfigRelativePath)
	if path != wantPath {
		t.Fatalf("default path = %q, want %q", path, wantPath)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("stat default tools config: %v", err)
	}

	cfg, loadedPath, err := LoadToolConfigForRepo(repoDir)
	if err != nil {
		t.Fatalf("LoadToolConfigForRepo: %v", err)
	}
	if loadedPath != wantPath {
		t.Fatalf("loaded path = %q, want %q", loadedPath, wantPath)
	}
	if cfg == nil {
		t.Fatal("expected non-nil available tool config")
	}
	if _, ok := cfg.Tools["claude"]; !ok {
		t.Fatal("expected default claude tool")
	}
	if _, ok := cfg.Tools["codex"]; !ok {
		t.Fatal("expected default codex tool")
	}
}

func TestLoadToolConfigUsesOnlyOrcaPath(t *testing.T) {
	repoDir := t.TempDir()
	setToolConfig(nil, "")
	t.Cleanup(func() { setToolConfig(nil, "") })
	withLookPathStub(t, func(bin string) (string, error) { return "/usr/bin/" + bin, nil })

	rootPath := filepath.Join(repoDir, "tools.json")
	if err := os.WriteFile(rootPath, []byte(testToolConfigJSON), 0o644); err != nil {
		t.Fatalf("write root tools.json: %v", err)
	}

	cfg, loadedPath, err := LoadToolConfigForRepo(repoDir)
	if err != nil {
		t.Fatalf("LoadToolConfigForRepo: %v", err)
	}
	if loadedPath != "" {
		t.Fatalf("loaded path = %q, want empty", loadedPath)
	}
	if cfg != nil {
		t.Fatalf("expected nil loaded cfg when only root tools.json exists, got %#v", cfg)
	}
}

func TestLoadToolConfigFiltersMissingBinaries(t *testing.T) {
	repoDir := t.TempDir()
	setToolConfig(nil, "")
	t.Cleanup(func() { setToolConfig(nil, "") })
	withLookPathStub(t, func(bin string) (string, error) {
		if bin == "codex-test" {
			return "/usr/bin/codex-test", nil
		}
		return "", errors.New("not found")
	})

	orcaPath := filepath.Join(repoDir, DefaultToolsConfigRelativePath)
	if err := os.MkdirAll(filepath.Dir(orcaPath), 0o755); err != nil {
		t.Fatalf("mkdir .orca: %v", err)
	}
	jsonConfig := `{
  "tools": {
    "claude": {
      "binary": "claude-missing",
      "models": ["claude-sonnet-4-6"],
      "args": [
        { "param": "-p", "variable": "prompt", "used_in": ["headless"] }
      ],
      "session_id": { "mode": "json", "key": "session_id" },
      "timeout": "600s"
    },
    "codex": {
      "binary": "codex-test",
      "models": ["gpt-5.3-codex"],
      "args": [
        { "param": "--prompt", "variable": "prompt", "used_in": ["headless"] }
      ],
      "session_id": { "mode": "json", "key": "thread_id" },
      "timeout": "600s"
    }
  }
}`
	if err := os.WriteFile(orcaPath, []byte(jsonConfig), 0o644); err != nil {
		t.Fatalf("write .orca tools.json: %v", err)
	}

	cfg, loadedPath, err := LoadToolConfigForRepo(repoDir)
	if err != nil {
		t.Fatalf("LoadToolConfigForRepo: %v", err)
	}
	if loadedPath != orcaPath {
		t.Fatalf("loaded path = %q, want %q", loadedPath, orcaPath)
	}
	if cfg == nil {
		t.Fatal("expected non-nil tool config")
	}
	if _, ok := cfg.Tools["claude"]; ok {
		t.Fatal("did not expect claude (missing binary) in available tools")
	}
	if _, ok := cfg.Tools["codex"]; !ok {
		t.Fatal("expected codex in available tools")
	}
}
