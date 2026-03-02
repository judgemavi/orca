package driver

import "testing"

func TestClaudeParseEvent_TextDelta(t *testing.T) {
	d := &Claude{}
	line := []byte(`{"type":"stream_event","event":{"delta":{"type":"text_delta","text":"hello"}}}`)

	e, err := d.ParseEvent(line)
	if err != nil {
		t.Fatalf("ParseEvent error: %v", err)
	}
	if e.Type != EventText {
		t.Fatalf("Type=%v want=%v", e.Type, EventText)
	}
	if e.Text != "hello" {
		t.Fatalf("Text=%q want=%q", e.Text, "hello")
	}
}

func TestClaudeParseEvent_ResultCostAndSession(t *testing.T) {
	d := &Claude{}
	line := []byte(`{"type":"result","session_id":"sess-123","total_cost_usd":0.12,"usage":{"input_tokens":100,"output_tokens":20}}`)

	e, err := d.ParseEvent(line)
	if err != nil {
		t.Fatalf("ParseEvent error: %v", err)
	}
	if e.Type != EventCost {
		t.Fatalf("Type=%v want=%v", e.Type, EventCost)
	}
	if e.SessionID != "sess-123" {
		t.Fatalf("SessionID=%q want=%q", e.SessionID, "sess-123")
	}
	if e.Cost == nil {
		t.Fatal("Cost is nil")
	}
	if e.Cost.InputTokens != 100 || e.Cost.OutputTokens != 20 {
		t.Fatalf("tokens=(%d,%d) want=(100,20)", e.Cost.InputTokens, e.Cost.OutputTokens)
	}
	if e.Cost.TotalCost != 0.12 {
		t.Fatalf("TotalCost=%v want=0.12", e.Cost.TotalCost)
	}
}

func TestClaudeParseSessionID(t *testing.T) {
	d := &Claude{}
	events := []Event{
		{Type: EventStatus},
		{Type: EventCost, SessionID: "sess-a"},
		{Type: EventCost, SessionID: "sess-b"},
	}
	if got := d.ParseSessionID(events); got != "sess-b" {
		t.Fatalf("ParseSessionID=%q want=%q", got, "sess-b")
	}
}

func TestClaudeFormatEvent_ToolUseAndInputJSONDelta(t *testing.T) {
	d := &Claude{}
	start := []byte(`{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"tool_use","name":"Read"}}}`)
	delta := []byte(`{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\"path\":\"internal/api/server.go\"}"}}}`)
	stop := []byte(`{"type":"stream_event","event":{"type":"content_block_stop"}}`)

	if got := d.FormatEvent(start); got != "[tool: Read]\n" {
		t.Fatalf("start=%q", got)
	}
	if got := d.FormatEvent(delta); got != "{\"path\":\"internal/api/server.go\"}" {
		t.Fatalf("delta=%q", got)
	}
	if got := d.FormatEvent(stop); got != "\n" {
		t.Fatalf("stop=%q", got)
	}
}

func TestClaudeFormatEvent_ResultSummaryAndNoise(t *testing.T) {
	d := &Claude{}
	line := []byte(`{"type":"result","session_id":"abc-123","total_cost_usd":0.045,"usage":{"input_tokens":4200,"output_tokens":1800}}`)
	if got := d.FormatEvent(line); got != "[session: abc-123 | tokens: 4.2k in / 1.8k out | cost: $0.045]\n" {
		t.Fatalf("summary=%q", got)
	}

	noise := []byte(`{"type":"stream_event","event":{"type":"message_start"}}`)
	if got := d.FormatEvent(noise); got != "[message start]\n" {
		t.Fatalf("message_start=%q want=%q", got, "[message start]\n")
	}
}
