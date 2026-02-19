package worker

import "testing"

func TestExtractClaudeResult(t *testing.T) {
	// Real Claude envelope.
	envelope := `{"type":"result","subtype":"success","is_error":false,"duration_ms":4953,"num_turns":1,"result":"Here is the analysis...","total_cost_usd":0.03254575,"usage":{"input_tokens":3,"cache_creation_input_tokens":2913,"cache_read_input_tokens":18751,"output_tokens":188}}`
	got := ExtractClaudeResult(envelope)
	if got != "Here is the analysis..." {
		t.Fatalf("ExtractClaudeResult(envelope) = %q, want %q", got, "Here is the analysis...")
	}

	// Non-JSON passthrough.
	plain := "just some text output"
	if got := ExtractClaudeResult(plain); got != plain {
		t.Fatalf("ExtractClaudeResult(plain) = %q, want %q", got, plain)
	}

	// JSON but not a Claude envelope (no type field).
	other := `{"foo":"bar"}`
	if got := ExtractClaudeResult(other); got != other {
		t.Fatalf("ExtractClaudeResult(other json) = %q, want %q", got, other)
	}

	// Envelope with empty result — should pass through.
	emptyResult := `{"type":"result","result":""}`
	if got := ExtractClaudeResult(emptyResult); got != emptyResult {
		t.Fatalf("ExtractClaudeResult(empty result) = %q, want passthrough", got)
	}

	// Empty string.
	if got := ExtractClaudeResult(""); got != "" {
		t.Fatalf("ExtractClaudeResult(empty) = %q, want empty", got)
	}
}
