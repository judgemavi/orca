package driver

import "testing"

func TestCodexParseEvent_AgentMessage(t *testing.T) {
	d := &Codex{}
	line := []byte(`{"type":"item.completed","item":{"type":"agent_message","text":"done"}}`)
	e, err := d.ParseEvent(line)
	if err != nil {
		t.Fatalf("ParseEvent error: %v", err)
	}
	if e.Type != EventText || e.Text != "done" {
		t.Fatalf("event=%+v", e)
	}
}

func TestCodexParseEvent_TurnCompletedUsage(t *testing.T) {
	d := &Codex{}
	line := []byte(`{"type":"turn.completed","usage":{"input_tokens":24763,"output_tokens":122}}`)
	e, err := d.ParseEvent(line)
	if err != nil {
		t.Fatalf("ParseEvent error: %v", err)
	}
	if e.Type != EventCost || e.Cost == nil {
		t.Fatalf("event=%+v", e)
	}
	if e.Cost.InputTokens != 24763 || e.Cost.OutputTokens != 122 {
		t.Fatalf("tokens=(%d,%d)", e.Cost.InputTokens, e.Cost.OutputTokens)
	}
}

func TestCodexParseEvent_ThreadStartedSession(t *testing.T) {
	d := &Codex{}
	line := []byte(`{"type":"thread.started","thread_id":"thread_abc"}`)
	e, err := d.ParseEvent(line)
	if err != nil {
		t.Fatalf("ParseEvent error: %v", err)
	}
	if e.Type != EventSession || e.SessionID != "thread_abc" {
		t.Fatalf("event=%+v", e)
	}
}

func TestCodexParseSessionID(t *testing.T) {
	d := &Codex{}
	events := []Event{
		{Type: EventStatus},
		{Type: EventSession, SessionID: "thread_1"},
		{Type: EventSession, SessionID: "thread_2"},
	}
	if got := d.ParseSessionID(events); got != "thread_1" {
		t.Fatalf("ParseSessionID=%q want=%q", got, "thread_1")
	}
}

func TestCodexFormatEvent_StepEvents(t *testing.T) {
	d := &Codex{}

	tests := []struct {
		line string
		want string
	}{
		{`{"type":"thread.started","thread_id":"thread_abc123"}`, "[session: thread_abc123]\n"},
		{`{"type":"item.started","item":{"type":"command_execution","command":"bash -lc go test ./internal/auth/..."}}`, "[command: bash -lc go test ./internal/auth/...]\n"},
		{`{"type":"item.started","item":{"type":"file_change","file":"internal/auth/auth.go"}}`, "[file: internal/auth/auth.go]\n"},
		{`{"type":"item.started","item":{"type":"reasoning"}}`, "[thinking...]\n"},
		{`{"type":"item.started","item":{"type":"mcp_tool_call","name":"search_query"}}`, "[mcp: search_query]\n"},
		{`{"type":"item.completed","item":{"type":"agent_message","text":"Fixed issue."}}`, "Fixed issue.\n"},
		{`{"type":"item.completed","item":{"type":"command_execution","exit_code":1}}`, "[exit: 1]\n"},
		{`{"type":"turn.completed","usage":{"input_tokens":24800,"output_tokens":450}}`, "[tokens: 24.8k in / 450 out]\n"},
		{`{"type":"turn.failed","error":"command failed"}`, "[error: command failed]\n"},
	}

	for _, tt := range tests {
		if got := d.FormatEvent([]byte(tt.line)); got != tt.want {
			t.Fatalf("line=%s got=%q want=%q", tt.line, got, tt.want)
		}
	}
}

func TestCodexFormatEvent_Noise(t *testing.T) {
	d := &Codex{}
	line := []byte(`{"type":"item.updated","item":{"type":"command_execution"}}`)
	if got := d.FormatEvent(line); got != "" {
		t.Fatalf("noise should be empty, got=%q", got)
	}
}
