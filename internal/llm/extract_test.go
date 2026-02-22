package llm

import (
	"errors"
	"testing"
)

func TestExtractJSON_CleanJSON(t *testing.T) {
	var dst struct {
		Name string `json:"name"`
	}

	if err := ExtractJSON(`{"name":"alice"}`, &dst); err != nil {
		t.Fatalf("ExtractJSON returned error: %v", err)
	}
	if dst.Name != "alice" {
		t.Fatalf("expected name alice, got %q", dst.Name)
	}
}

func TestExtractJSON_MarkdownFence(t *testing.T) {
	var dst struct {
		Count int `json:"count"`
	}

	raw := "```json\n{\"count\":3}\n```"
	if err := ExtractJSON(raw, &dst); err != nil {
		t.Fatalf("ExtractJSON returned error: %v", err)
	}
	if dst.Count != 3 {
		t.Fatalf("expected count 3, got %d", dst.Count)
	}
}

func TestExtractJSON_LeadingTrailingText(t *testing.T) {
	var dst struct {
		OK bool `json:"ok"`
	}

	raw := "Some explanation first.\n{\"ok\":true}\nAnd some trailing prose."
	if err := ExtractJSON(raw, &dst); err != nil {
		t.Fatalf("ExtractJSON returned error: %v", err)
	}
	if !dst.OK {
		t.Fatalf("expected ok true")
	}
}

func TestExtractJSON_NestedObjects(t *testing.T) {
	var dst struct {
		Meta struct {
			Items []struct {
				Value string `json:"value"`
			} `json:"items"`
		} `json:"meta"`
	}

	raw := `{"meta":{"items":[{"value":"a"},{"value":"b"}]}}`
	if err := ExtractJSON(raw, &dst); err != nil {
		t.Fatalf("ExtractJSON returned error: %v", err)
	}
	if len(dst.Meta.Items) != 2 || dst.Meta.Items[1].Value != "b" {
		t.Fatalf("unexpected parsed nested output: %#v", dst)
	}
}

func TestExtractJSON_NoJSONFound(t *testing.T) {
	var dst map[string]interface{}

	err := ExtractJSON("no structured output here", &dst)
	if !errors.Is(err, ErrNoJSON) {
		t.Fatalf("expected ErrNoJSON, got %v", err)
	}
}

func TestExtractJSON_InvalidJSON(t *testing.T) {
	var dst map[string]interface{}

	err := ExtractJSON("prefix {invalid json} suffix", &dst)
	if err == nil {
		t.Fatalf("expected unmarshal error, got nil")
	}
	if errors.Is(err, ErrNoJSON) {
		t.Fatalf("expected unmarshal error, got ErrNoJSON")
	}
}

func TestExtractJSON_EmptyInput(t *testing.T) {
	var dst map[string]interface{}

	err := ExtractJSON("   \n\t ", &dst)
	if !errors.Is(err, ErrNoJSON) {
		t.Fatalf("expected ErrNoJSON, got %v", err)
	}
}

func TestTryExtractJSON_NoJSONFound(t *testing.T) {
	var dst map[string]interface{}

	found, err := TryExtractJSON("plain text only", &dst)
	if err != nil {
		t.Fatalf("expected nil error, got %v", err)
	}
	if found {
		t.Fatalf("expected found=false, got true")
	}
}
