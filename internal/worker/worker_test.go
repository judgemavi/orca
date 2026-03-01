package worker

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jasjeetmavi/orca/internal/driver"
)

func TestNewAdapter(t *testing.T) {
	d, _ := driver.Get("claude")
	a := NewAdapter(d, "claude-sonnet-4-6", time.Minute)
	if a == nil || a.Driver == nil {
		t.Fatal("expected adapter with driver")
	}
}

func TestSessionIDCallbackFiresBeforeExecuteReturns(t *testing.T) {
	a := NewAdapter(&streamingSessionDriver{}, "", 3*time.Second)

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

type streamingSessionDriver struct{}

func (d *streamingSessionDriver) Name() string { return "streaming-session-test" }
func (d *streamingSessionDriver) Binary() string {
	return "sh"
}
func (d *streamingSessionDriver) Models() []string { return nil }
func (d *streamingSessionDriver) HeadlessArgs(prompt, model, dir string) []string {
	return []string{
		"-c",
		"printf 'session:sess-123\\n'; sleep 0.25; printf 'text:done\\n'",
	}
}
func (d *streamingSessionDriver) ResumeArgs(sessionID, feedback, model, dir string) []string {
	return d.HeadlessArgs("", model, dir)
}

func (d *streamingSessionDriver) ParseEvent(line []byte) (driver.Event, error) {
	text := strings.TrimSpace(string(line))
	switch {
	case strings.HasPrefix(text, "session:"):
		return driver.Event{Type: driver.EventSession, SessionID: strings.TrimPrefix(text, "session:")}, nil
	case strings.HasPrefix(text, "cost:"):
		return driver.Event{
			Type:      driver.EventCost,
			SessionID: strings.TrimPrefix(text, "cost:"),
			Cost:      &driver.Cost{},
		}, nil
	case strings.HasPrefix(text, "text:"):
		return driver.Event{Type: driver.EventText, Text: strings.TrimPrefix(text, "text:")}, nil
	default:
		return driver.Event{}, fmt.Errorf("unknown line %q", text)
	}
}
func (d *streamingSessionDriver) FormatEvent(line []byte) string { return string(line) }
func (d *streamingSessionDriver) ParseSessionID(events []driver.Event) string {
	for _, e := range events {
		if e.SessionID != "" {
			return e.SessionID
		}
	}
	return ""
}
