package orchestrator

import (
	"strings"
	"testing"

	"github.com/jasjeetmavi/orca/internal/config"
)

func TestBuildLaunchArgs_ClaudeWithPlaceholders(t *testing.T) {
	toolCfg := config.ToolConfig{
		Model: "claude-sonnet-4-6",
		InteractiveArgs: []string{
			"--mcp-config", "{{mcp_config}}",
			"--allowedTools", "{{allowed_tools}}",
			"--append-system-prompt", "{{context}}",
		},
	}

	args := BuildLaunchArgs(toolCfg, "/tmp/mcp.json")

	assertContains(t, args, "--mcp-config")
	assertContains(t, args, "/tmp/mcp.json")
	assertContains(t, args, "--allowedTools")
	assertContains(t, args, "--model")
	assertContains(t, args, "claude-sonnet-4-6")

	// Placeholders must be resolved
	for _, a := range args {
		if strings.Contains(a, "{{") {
			t.Fatalf("unresolved placeholder in args: %q", a)
		}
	}

	// System prompt injected via {{context}}
	assertContains(t, args, SystemPrompt)
}

func TestBuildLaunchArgs_CodexNoMCP(t *testing.T) {
	toolCfg := config.ToolConfig{
		Model: "gpt-5-codex",
		InteractiveArgs: []string{
			"-a", "never", "{{context}}",
		},
	}

	args := BuildLaunchArgs(toolCfg, "/tmp/mcp.json")

	// Codex args should NOT contain Claude-specific flags
	assertNotContains(t, args, "--mcp-config")
	assertNotContains(t, args, "--allowedTools")

	assertContains(t, args, "-a")
	assertContains(t, args, "never")
	assertContains(t, args, "--model")
	assertContains(t, args, "gpt-5-codex")
}

func TestBuildLaunchArgs_NoArgs(t *testing.T) {
	toolCfg := config.ToolConfig{
		Model: "some-model",
	}

	args := BuildLaunchArgs(toolCfg, "/tmp/mcp.json")
	if args != nil {
		t.Fatalf("expected nil args, got %v", args)
	}
}

func TestBuildLaunchArgs_ModelPlaceholder(t *testing.T) {
	toolCfg := config.ToolConfig{
		Model: "claude-opus-4-6",
		InteractiveArgs: []string{
			"--model", "{{model}}",
			"--append-system-prompt", "{{context}}",
		},
	}

	args := BuildLaunchArgs(toolCfg, "/tmp/mcp.json")

	// Model should appear exactly once (from placeholder, not appended again)
	count := 0
	for _, a := range args {
		if a == "--model" {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("expected --model once, got %d times in %v", count, args)
	}

	assertContains(t, args, "claude-opus-4-6")
}

func assertContains(t *testing.T, args []string, want string) {
	t.Helper()
	for _, a := range args {
		if a == want {
			return
		}
	}
	t.Fatalf("args %v missing %q", args, want)
}

func assertNotContains(t *testing.T, args []string, bad string) {
	t.Helper()
	for _, a := range args {
		if a == bad {
			t.Fatalf("args %v should not contain %q", args, bad)
		}
	}
}
