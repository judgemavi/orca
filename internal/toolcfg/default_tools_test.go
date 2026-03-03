package toolcfg

import (
	"testing"
)

func TestDefaultToolsConfigLoadAndResolveArgs(t *testing.T) {
	cfg, err := DefaultConfig()
	if err != nil {
		t.Fatalf("DefaultConfig: %v", err)
	}

	claude, ok := cfg.Tools["claude"]
	if !ok {
		t.Fatal("tools.claude missing")
	}
	codex, ok := cfg.Tools["codex"]
	if !ok {
		t.Fatal("tools.codex missing")
	}

	claudeArgs := claude.ResolveArgs(ArgsModeHeadless, map[string]string{
		"prompt": "implement task",
		"model":  "claude-sonnet-4-6",
		"dir":    "/tmp/worktree",
	})
	if !containsArgPair(claudeArgs, "-p", "implement task") {
		t.Fatalf("claude headless args missing prompt resolution: %v", claudeArgs)
	}
	if !containsArgPair(claudeArgs, "--model", "claude-sonnet-4-6") {
		t.Fatalf("claude headless args missing model resolution: %v", claudeArgs)
	}

	codexResume := codex.ResolveArgs(ArgsModeResume, map[string]string{
		"dir":        "/tmp/worktree",
		"session_id": "thread-123",
		"feedback":   "please adjust",
		"model":      "gpt-5.3-codex",
	})
	if !containsArgPair(codexResume, "-C", "/tmp/worktree") {
		t.Fatalf("codex resume args missing dir resolution: %v", codexResume)
	}
	if !containsArgPair(codexResume, "--resume", "thread-123") {
		t.Fatalf("codex resume args missing resume/session resolution: %v", codexResume)
	}
}

func TestDefaultSessionExtractionMatchesSamples(t *testing.T) {
	cfg, err := DefaultConfig()
	if err != nil {
		t.Fatalf("DefaultConfig: %v", err)
	}

	claude := cfg.Tools["claude"]
	codex := cfg.Tools["codex"]

	claudeLine := `{"type":"result","session_id":"claude-session-42","usage":{"input_tokens":11,"output_tokens":7},"total_cost_usd":0.02}`
	if got := ExtractSessionID(claude.SessionID, claudeLine); got != "claude-session-42" {
		t.Fatalf("claude session extract = %q, want claude-session-42", got)
	}

	codexLine := `{"type":"thread.started","thread_id":"thread_abc123"}`
	if got := ExtractSessionID(codex.SessionID, codexLine); got != "thread_abc123" {
		t.Fatalf("codex session extract = %q, want thread_abc123", got)
	}
}

func containsArgPair(args []string, key, value string) bool {
	for i := 0; i < len(args)-1; i++ {
		if args[i] == key && args[i+1] == value {
			return true
		}
	}
	return false
}
