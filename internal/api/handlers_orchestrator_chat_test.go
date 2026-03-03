package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"testing"

	"github.com/jasjeetmavi/orca/internal/config"
	"github.com/jasjeetmavi/orca/internal/driver"
	"github.com/jasjeetmavi/orca/internal/state"
	"github.com/jasjeetmavi/orca/internal/testutil"
)

func TestHandleOrchestratorChatStreamsAndPersists(t *testing.T) {
	db := testutil.DB(t)
	cfg, err := config.Default()
	if err != nil {
		t.Fatalf("default config: %v", err)
	}
	cfg.Tools = []string{"claude"}
	cfg.Orchestrator.SupervisorTool = "claude"

	srv := &Server{
		db:      db,
		cfg:     &cfg,
		repoDir: t.TempDir(),
		hub:     NewHub(),
	}

	origExec := orchestratorChatExecCommandContext
	origExecutable := orchestratorChatExecutable
	t.Cleanup(func() {
		orchestratorChatExecCommandContext = origExec
		orchestratorChatExecutable = origExecutable
	})

	var capturedArgs []string
	orchestratorChatExecCommandContext = func(ctx context.Context, name string, args ...string) *exec.Cmd {
		capturedArgs = append([]string{name}, args...)
		cmd := exec.CommandContext(
			ctx,
			os.Args[0],
			"-test.run=TestHelperProcessOrchestratorChat",
			"--",
			"orchestrator-chat-helper",
		)
		return cmd
	}
	orchestratorChatExecutable = func() (string, error) {
		return "/tmp/orca-test-binary", nil
	}

	req := httptest.NewRequest(http.MethodPost, "/api/v1/orchestrator/chat", strings.NewReader(`{"message":"list tasks"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	srv.Routes().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	body := rec.Body.String()
	for _, want := range []string{
		"event: text",
		"event: tool_use",
		"event: tool_result",
		"event: done",
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("missing %q in SSE body:\n%s", want, body)
		}
	}
	if !contains(capturedArgs, "--mcp-config") {
		t.Fatalf("expected --mcp-config in args, got %v", capturedArgs)
	}

	session, err := db.GetActiveOrchestratorSession()
	if err != nil {
		t.Fatalf("get active session: %v", err)
	}
	if session == nil {
		t.Fatal("expected active session")
	}
	if session.ClaudeSessionID != "claude-session-42" {
		t.Fatalf("claude session id = %q, want %q", session.ClaudeSessionID, "claude-session-42")
	}

	msgs, err := db.ListOrchestratorMessages(session.ID)
	if err != nil {
		t.Fatalf("list messages: %v", err)
	}
	if len(msgs) != 4 {
		t.Fatalf("message count = %d, want 4", len(msgs))
	}
	if msgs[0].Role != "user" {
		t.Fatalf("first role = %q, want %q", msgs[0].Role, "user")
	}
	if !hasRole(msgs, "assistant") || !hasRole(msgs, "tool_use") || !hasRole(msgs, "tool_result") {
		t.Fatalf("unexpected roles in messages: %+v", msgs)
	}
}

func TestHandleOrchestratorHistoryAndNewSession(t *testing.T) {
	db := testutil.DB(t)
	cfg, err := config.Default()
	if err != nil {
		t.Fatalf("default config: %v", err)
	}
	cfg.Orchestrator.SupervisorTool = "claude"

	srv := &Server{
		db:      db,
		cfg:     &cfg,
		repoDir: t.TempDir(),
		hub:     NewHub(),
	}

	if err := db.CreateOrchestratorSession("sess-old", "claude", "claude-sonnet-4-6"); err != nil {
		t.Fatalf("create session: %v", err)
	}
	if err := db.InsertOrchestratorMessage("m1", "sess-old", "user", "hello", `{"from":"test"}`); err != nil {
		t.Fatalf("insert message: %v", err)
	}

	historyReq := httptest.NewRequest(http.MethodGet, "/api/v1/orchestrator/chat/history", nil)
	historyRec := httptest.NewRecorder()
	srv.Routes().ServeHTTP(historyRec, historyReq)
	if historyRec.Code != http.StatusOK {
		t.Fatalf("history status = %d, want %d; body=%s", historyRec.Code, http.StatusOK, historyRec.Body.String())
	}
	var historyResp struct {
		Data []orchestratorHistoryMessage `json:"data"`
	}
	if err := json.Unmarshal(historyRec.Body.Bytes(), &historyResp); err != nil {
		t.Fatalf("decode history response: %v", err)
	}
	if len(historyResp.Data) != 1 {
		t.Fatalf("history count = %d, want 1", len(historyResp.Data))
	}
	if historyResp.Data[0].Metadata["from"] != "test" {
		t.Fatalf("metadata = %#v, want key from=test", historyResp.Data[0].Metadata)
	}

	newReq := httptest.NewRequest(http.MethodPost, "/api/v1/orchestrator/chat/new", nil)
	newRec := httptest.NewRecorder()
	srv.Routes().ServeHTTP(newRec, newReq)
	if newRec.Code != http.StatusOK {
		t.Fatalf("new session status = %d, want %d; body=%s", newRec.Code, http.StatusOK, newRec.Body.String())
	}
	var newResp struct {
		Data struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(newRec.Body.Bytes(), &newResp); err != nil {
		t.Fatalf("decode new session response: %v", err)
	}
	if strings.TrimSpace(newResp.Data.ID) == "" {
		t.Fatalf("new session id is empty: %s", newRec.Body.String())
	}

	active, err := db.GetActiveOrchestratorSession()
	if err != nil {
		t.Fatalf("get active session: %v", err)
	}
	if active == nil || active.ID != newResp.Data.ID {
		t.Fatalf("active session = %+v, want id %q", active, newResp.Data.ID)
	}

	var oldStatus string
	if err := db.QueryRow(`SELECT status FROM orchestrator_sessions WHERE id = ?`, "sess-old").Scan(&oldStatus); err != nil {
		t.Fatalf("query old session: %v", err)
	}
	if oldStatus != "closed" {
		t.Fatalf("old session status = %q, want %q", oldStatus, "closed")
	}
}

func TestBuildOrchestratorChatArgsPrefersResumeWhenAvailable(t *testing.T) {
	d, ok := driver.Get("claude")
	if !ok {
		t.Fatal("claude driver missing")
	}
	args := buildOrchestratorChatArgs(
		d,
		&state.OrchestratorSessionRow{
			Tool:            "claude",
			Model:           "claude-sonnet-4-6",
			ClaudeSessionID: "sess-123",
		},
		"prompt",
		"follow up",
		"/tmp/mcp.json",
		"/tmp/repo",
	)
	if !contains(args, "--resume") {
		t.Fatalf("expected --resume args, got %v", args)
	}
}

func TestHelperProcessOrchestratorChat(t *testing.T) {
	if len(os.Args) == 0 || os.Args[len(os.Args)-1] != "orchestrator-chat-helper" {
		return
	}

	lines := []string{
		`{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"tool_use","id":"toolu_1","name":"mcp__orca__tasks_list","input":{"status":"pending"}}}}`,
		`{"type":"stream_event","event":{"delta":{"type":"text_delta","text":"Found pending tasks."}}}`,
		`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"[]","is_error":false}]}}`,
		`{"type":"result","session_id":"claude-session-42","usage":{"input_tokens":11,"output_tokens":7},"total_cost_usd":0.02}`,
	}
	for _, line := range lines {
		_, _ = os.Stdout.WriteString(line + "\n")
	}
	os.Exit(0)
}

func contains(items []string, want string) bool {
	for _, item := range items {
		if item == want {
			return true
		}
	}
	return false
}

func hasRole(rows []state.OrchestratorMessageRow, role string) bool {
	for _, row := range rows {
		if row.Role == role {
			return true
		}
	}
	return false
}
