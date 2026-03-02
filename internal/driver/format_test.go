package driver

import "testing"

func TestFormatLog_Claude(t *testing.T) {
	raw := "" +
		`{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"I'll implement"}}}` + "\n" +
		`{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":" the authentication"}}}` + "\n" +
		`{"type":"result","session_id":"abc-123","total_cost_usd":0.045,"usage":{"input_tokens":1200,"output_tokens":450}}` + "\n"

	got := FormatLog("claude", raw)
	want := "I'll implement the authentication[session: abc-123 | tokens: 1.2k in / 450 out | cost: $0.045]\n"
	if got != want {
		t.Fatalf("FormatLog mismatch\ngot:  %q\nwant: %q", got, want)
	}
}

func TestFormatLine_CodexCost(t *testing.T) {
	line := []byte(`{"type":"turn.completed","usage":{"input_tokens":24763,"output_tokens":122}}`)
	got := FormatLine("codex", line)
	want := "[tokens: 24.8k in / 122 out]\n"
	if got != want {
		t.Fatalf("FormatLine mismatch\ngot:  %q\nwant: %q", got, want)
	}
}

func TestFormatLog_UnknownToolReturnsRaw(t *testing.T) {
	raw := "{\"hello\":\"world\"}\n"
	if got := FormatLog("unknown-tool", raw); got != raw {
		t.Fatalf("FormatLog=%q want raw=%q", got, raw)
	}
}
