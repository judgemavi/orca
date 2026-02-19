package worker

import (
	"context"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/jasjeetmavi/pod/internal/config"
)

func TestNewAdapter(t *testing.T) {
	t.Run("valid config", func(t *testing.T) {
		cfg := config.ToolConfig{
			Binary:       "echo",
			HeadlessArgs: []string{"hello"},
			Timeout:      "60s",
		}
		a, err := NewAdapter(cfg)
		if err != nil {
			t.Fatalf("NewAdapter: %v", err)
		}
		if a.Timeout != 60*time.Second {
			t.Errorf("timeout = %v, want 60s", a.Timeout)
		}
		if a.Binary != "echo" {
			t.Errorf("binary = %q, want %q", a.Binary, "echo")
		}
	})

	t.Run("invalid timeout", func(t *testing.T) {
		cfg := config.ToolConfig{
			Binary:       "echo",
			HeadlessArgs: []string{"hello"},
			Timeout:      "bad",
		}
		_, err := NewAdapter(cfg)
		if err == nil {
			t.Fatal("expected error for invalid timeout")
		}
	})
}

func TestNewWorker(t *testing.T) {
	t.Run("defaults to headless adapter", func(t *testing.T) {
		cfg := config.ToolConfig{
			Binary:       "echo",
			HeadlessArgs: []string{"{{prompt}}"},
			Timeout:      "30s",
		}

		w, err := NewWorker(cfg)
		if err != nil {
			t.Fatalf("NewWorker: %v", err)
		}
		if _, ok := w.(*Adapter); !ok {
			t.Fatalf("worker type = %T, want *Adapter", w)
		}
	})

	t.Run("uses interactive adapter when configured", func(t *testing.T) {
		cfg := config.ToolConfig{
			Binary:          "echo",
			InteractiveArgs: []string{"{{context}}"},
			Timeout:         "30s",
			Mode:            "interactive",
		}

		w, err := NewWorker(cfg)
		if err != nil {
			t.Fatalf("NewWorker: %v", err)
		}
		if _, ok := w.(*InteractiveAdapter); !ok {
			t.Fatalf("worker type = %T, want *InteractiveAdapter", w)
		}
	})
}

func initGitRepo(t *testing.T, dir string) {
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

func TestExecuteSuccess(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}

	dir := t.TempDir()
	initGitRepo(t, dir)

	cfg := config.ToolConfig{
		Binary:       "echo",
		HeadlessArgs: []string{"{{prompt}}"},
		Timeout:      "30s",
	}
	a, err := NewAdapter(cfg)
	if err != nil {
		t.Fatalf("NewAdapter: %v", err)
	}

	res, err := a.Execute(context.Background(), "test-task", "hello world", dir)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if res.ExitCode != 0 {
		t.Errorf("exit code = %d, want 0", res.ExitCode)
	}
	if !strings.Contains(res.Stdout, "hello world") {
		t.Errorf("stdout = %q, want it to contain %q", res.Stdout, "hello world")
	}
	if res.Duration <= 0 {
		t.Errorf("duration = %v, want > 0", res.Duration)
	}
}

func TestExecuteFailure(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}

	dir := t.TempDir()
	initGitRepo(t, dir)

	cfg := config.ToolConfig{
		Binary:       "false",
		HeadlessArgs: []string{},
		Timeout:      "30s",
	}
	a, err := NewAdapter(cfg)
	if err != nil {
		t.Fatalf("NewAdapter: %v", err)
	}

	res, err := a.Execute(context.Background(), "fail-task", "test", dir)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if res.ExitCode != 1 {
		t.Errorf("exit code = %d, want 1", res.ExitCode)
	}
}

func TestExecuteTimeout(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}

	dir := t.TempDir()
	initGitRepo(t, dir)

	cfg := config.ToolConfig{
		Binary:       "sleep",
		HeadlessArgs: []string{"10"},
		Timeout:      "100ms",
	}
	a, err := NewAdapter(cfg)
	if err != nil {
		t.Fatalf("NewAdapter: %v", err)
	}

	res, err := a.Execute(context.Background(), "timeout-task", "test", dir)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if res.ExitCode != -1 {
		t.Errorf("exit code = %d, want -1", res.ExitCode)
	}
	if !strings.Contains(res.Stderr, "timeout") && !strings.Contains(res.Stderr, "cancelled") {
		t.Errorf("stderr = %q, want it to contain 'timeout' or 'cancelled'", res.Stderr)
	}
}

func TestPromptSubstitution(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}

	dir := t.TempDir()
	initGitRepo(t, dir)

	cfg := config.ToolConfig{
		Binary:       "echo",
		HeadlessArgs: []string{"before", "{{prompt}}", "after"},
		Timeout:      "30s",
	}
	a, err := NewAdapter(cfg)
	if err != nil {
		t.Fatalf("NewAdapter: %v", err)
	}

	res, err := a.Execute(context.Background(), "sub-task", "hello", dir)
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	// echo outputs: "before hello after\n"
	expected := "before hello after"
	if !strings.Contains(res.Stdout, expected) {
		t.Errorf("stdout = %q, want it to contain %q", res.Stdout, expected)
	}
}
