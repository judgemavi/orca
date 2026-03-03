package worker

import (
	"context"
	"testing"
	"time"

	"github.com/jasjeetmavi/orca/internal/config"
	"github.com/jasjeetmavi/orca/internal/toolcfg"
)

func TestNewAdapter(t *testing.T) {
	tool, ok := config.ToolDefinition("claude")
	if !ok {
		t.Fatal("expected built-in claude tool definition")
	}
	a := NewAdapter("claude", tool, "claude-sonnet-4-6", time.Minute)
	if a == nil || a.ToolName != "claude" {
		t.Fatal("expected adapter with tool name")
	}
}

func TestSessionIDCallbackFiresBeforeExecuteReturns(t *testing.T) {
	a := NewAdapter("streaming-session-test", toolcfg.Tool{
		Binary: "sh",
		Args: []toolcfg.Arg{
			{Param: "-c", Value: "printf 'session:sess-123\\n'; sleep 0.25; printf 'text:done\\n'", UsedIn: []string{"headless", "resume"}},
			{Param: "--prompt", Variable: "prompt", UsedIn: []string{"headless"}},
			{Param: "--resume", Variable: "session_id", UsedIn: []string{"resume"}},
			{Param: "--prompt", Variable: "feedback", UsedIn: []string{"resume"}},
		},
		SessionID: toolcfg.SessionID{
			Mode:    "pattern",
			Pattern: `session:([a-zA-Z0-9-]+)`,
		},
		Timeout: "3s",
	}, "", 3*time.Second)

	sessionCh := make(chan string, 1)
	a.SetSessionIDCallback(func(sessionID string) {
		sessionCh <- sessionID
	})

	worktreePath := t.TempDir()
	done := make(chan struct{})
	var (
		result *Result
		err    error
	)
	go func() {
		defer close(done)
		result, err = a.Execute(context.Background(), "task-1", "prompt", worktreePath)
	}()

	select {
	case got := <-sessionCh:
		if got != "sess-123" {
			t.Fatalf("callback session_id=%q want %q", got, "sess-123")
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("timed out waiting for session callback")
	}

	select {
	case <-done:
		t.Fatal("execute returned before expected stream delay")
	default:
	}

	<-done
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if result == nil {
		t.Fatal("expected non-nil result")
	}
	if result.SessionID != "sess-123" {
		t.Fatalf("result session_id=%q want %q", result.SessionID, "sess-123")
	}
}
