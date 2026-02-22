package review

import (
	"testing"

	"github.com/jasjeetmavi/pod/internal/config"
)

func TestCheckAlignmentParsesDirectJSON(t *testing.T) {
	toolCfg := config.ToolConfig{
		Binary:       "sh",
		HeadlessArgs: []string{"-c", `printf '%s' '{"aligned": true, "reason": "implements requested task"}'`},
		Timeout:      "10s",
	}

	r := New(toolCfg, t.TempDir())

	res, err := r.CheckAlignment("t1", "Add alignment check", "Implement alignment logic", "diff --git a b")
	if err != nil {
		t.Fatalf("CheckAlignment returned error: %v", err)
	}
	if !res.Aligned {
		t.Fatalf("aligned = false, want true")
	}
	if res.Reason != "implements requested task" {
		t.Fatalf("reason = %q, want %q", res.Reason, "implements requested task")
	}
}

func TestCheckAlignmentExtractsJSONFromWrappedText(t *testing.T) {
	toolCfg := config.ToolConfig{
		Binary:       "sh",
		HeadlessArgs: []string{"-c", `printf '%s' "Here's my analysis: {\"aligned\": false, \"reason\": \"missing core requirement\"}"`},
		Timeout:      "10s",
	}

	r := New(toolCfg, t.TempDir())

	res, err := r.CheckAlignment("t2", "Add endpoint", "Add update endpoint", "diff --git a b")
	if err != nil {
		t.Fatalf("CheckAlignment returned error: %v", err)
	}
	if res.Aligned {
		t.Fatalf("aligned = true, want false")
	}
	if res.Reason != "missing core requirement" {
		t.Fatalf("reason = %q, want %q", res.Reason, "missing core requirement")
	}
}

func TestCheckAlignmentEmptyDiffSkipsLLMCall(t *testing.T) {
	toolCfg := config.ToolConfig{
		Binary:       "nonexistent-tool-that-does-not-exist",
		HeadlessArgs: []string{"{{prompt}}"},
		Timeout:      "10s",
	}

	r := New(toolCfg, t.TempDir())

	res, err := r.CheckAlignment("t3", "Any task", "Any description", "   \n\t")
	if err != nil {
		t.Fatalf("CheckAlignment returned error for empty diff: %v", err)
	}
	if res.Aligned {
		t.Fatalf("aligned = true, want false")
	}
	if res.Reason != "empty diff" {
		t.Fatalf("reason = %q, want %q", res.Reason, "empty diff")
	}
}
