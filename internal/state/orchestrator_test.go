package state

import (
	"testing"
	"time"
)

func TestOrchestratorSessionLifecycle(t *testing.T) {
	db := openTestDB(t)

	active, err := db.GetActiveOrchestratorSession()
	if err != nil {
		t.Fatalf("get active session: %v", err)
	}
	if active != nil {
		t.Fatalf("expected no active session, got %+v", *active)
	}

	if err := db.CreateOrchestratorSession("sess-1", "claude", "claude-sonnet-4-6"); err != nil {
		t.Fatalf("create session: %v", err)
	}

	active, err = db.GetActiveOrchestratorSession()
	if err != nil {
		t.Fatalf("get active session after create: %v", err)
	}
	if active == nil {
		t.Fatal("expected active session, got nil")
	}
	if active.ID != "sess-1" {
		t.Fatalf("active session id = %q, want %q", active.ID, "sess-1")
	}
	if active.Tool != "claude" {
		t.Fatalf("tool = %q, want %q", active.Tool, "claude")
	}
	if active.Model != "claude-sonnet-4-6" {
		t.Fatalf("model = %q, want %q", active.Model, "claude-sonnet-4-6")
	}

	if err := db.SetOrchestratorSessionResumeID("sess-1", "claude-session-123"); err != nil {
		t.Fatalf("set resume id: %v", err)
	}

	active, err = db.GetActiveOrchestratorSession()
	if err != nil {
		t.Fatalf("get active session after resume update: %v", err)
	}
	if active == nil || active.ClaudeSessionID != "claude-session-123" {
		t.Fatalf("claude_session_id = %q, want %q", active.ClaudeSessionID, "claude-session-123")
	}

	if err := db.CloseOrchestratorSession("sess-1"); err != nil {
		t.Fatalf("close session: %v", err)
	}
	active, err = db.GetActiveOrchestratorSession()
	if err != nil {
		t.Fatalf("get active session after close: %v", err)
	}
	if active != nil {
		t.Fatalf("expected no active session after close, got %+v", *active)
	}
}

func TestOrchestratorMessageInsertAndList(t *testing.T) {
	db := openTestDB(t)

	if err := db.CreateOrchestratorSession("sess-1", "claude", "claude-sonnet-4-6"); err != nil {
		t.Fatalf("create session: %v", err)
	}

	if err := db.InsertOrchestratorMessage("msg-1", "sess-1", "user", "hello", `{"source":"test"}`); err != nil {
		t.Fatalf("insert user message: %v", err)
	}
	time.Sleep(5 * time.Millisecond)
	if err := db.InsertOrchestratorMessage("msg-2", "sess-1", "assistant", "hi", `{}`); err != nil {
		t.Fatalf("insert assistant message: %v", err)
	}
	if err := db.InsertOrchestratorMessage("msg-3", "sess-1", "tool_use", "mcp__orca__tasks_list", `{"args":"{}"}`); err != nil {
		t.Fatalf("insert tool_use message: %v", err)
	}

	rows, err := db.ListOrchestratorMessages("sess-1")
	if err != nil {
		t.Fatalf("list messages: %v", err)
	}
	if len(rows) != 3 {
		t.Fatalf("message count = %d, want %d", len(rows), 3)
	}
	if rows[0].ID != "msg-1" || rows[1].ID != "msg-2" || rows[2].ID != "msg-3" {
		t.Fatalf("unexpected order: %#v", []string{rows[0].ID, rows[1].ID, rows[2].ID})
	}
	if rows[2].Metadata != `{"args":"{}"}` {
		t.Fatalf("metadata = %q, want %q", rows[2].Metadata, `{"args":"{}"}`)
	}
}

func openTestDB(t *testing.T) *DB {
	t.Helper()
	db, err := Open(t.TempDir() + "/state.db")
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}
