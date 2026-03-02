package plan

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/jasjeetmavi/orca/internal/knowledge"
	"github.com/jasjeetmavi/orca/prompts"
)

func TestBuildPlanPromptKnowledgePlacement(t *testing.T) {
	codebaseContext := "Context line"
	knowledgeSection := "## Relevant Knowledge\n\n1. Prefer table-driven tests"

	prompt := buildPlanPrompt(codebaseContext, knowledgeSection, "Task title", "Task description")
	prefix := strings.TrimSpace(prompts.OutputStyle) + "\n\n---\n\n"
	if !strings.HasPrefix(prompt, prefix) {
		t.Fatalf("prompt missing output style prefix")
	}

	contextIdx := strings.Index(prompt, "## Codebase Context")
	knowledgeIdx := strings.Index(prompt, "## Relevant Knowledge")
	taskIdx := strings.Index(prompt, "## Task")
	if contextIdx == -1 || knowledgeIdx == -1 || taskIdx == -1 {
		t.Fatalf("prompt missing expected sections: context=%d knowledge=%d task=%d", contextIdx, knowledgeIdx, taskIdx)
	}
	if !(contextIdx < knowledgeIdx && knowledgeIdx < taskIdx) {
		t.Fatalf("expected context -> knowledge -> task section order")
	}
}

func TestBuildKnowledgeSectionAndQualityJSON(t *testing.T) {
	entries := []*knowledge.Entry{
		{
			ID:             "k1",
			Content:        "Use retries for transient API failures.",
			Category:       "pattern",
			Confidence:     0.91,
			ProvenanceHash: "hash-a",
			Tags:           []string{"api", "retry"},
		},
		{
			ID:             "k2",
			Content:        "Prefer explicit timeouts in network clients.",
			Category:       "pitfall",
			Confidence:     0.83,
			ProvenanceHash: "hash-b",
		},
		{
			ID:             "k1",
			Content:        "Duplicate id should not duplicate usage metadata.",
			Category:       "pattern",
			Confidence:     0.75,
			ProvenanceHash: "hash-a",
		},
	}

	section, ids, hashes := buildKnowledgeSection(entries)
	if !strings.Contains(section, "## Relevant Knowledge") {
		t.Fatalf("knowledge section heading missing")
	}
	if !strings.Contains(section, "Use retries for transient API failures.") {
		t.Fatalf("knowledge section missing first entry content")
	}
	if !strings.Contains(section, "Prefer explicit timeouts in network clients.") {
		t.Fatalf("knowledge section missing second entry content")
	}

	if len(ids) != 2 || ids[0] != "k1" || ids[1] != "k2" {
		t.Fatalf("unexpected knowledge ids: %#v", ids)
	}
	if len(hashes) != 2 || hashes[0] != "hash-a" || hashes[1] != "hash-b" {
		t.Fatalf("unexpected provenance hashes: %#v", hashes)
	}

	qualityJSON, err := buildKnowledgeQualityJSON(
		[]string{"k1", "k2", "k1", "   "},
		[]string{"hash-a", "hash-b", "hash-a"},
	)
	if err != nil {
		t.Fatalf("build quality json: %v", err)
	}

	var got knowledgeUsageMetadata
	if err := json.Unmarshal([]byte(qualityJSON), &got); err != nil {
		t.Fatalf("unmarshal quality json: %v", err)
	}
	if len(got.UsedKnowledgeIDs) != 2 || got.UsedKnowledgeIDs[0] != "k1" || got.UsedKnowledgeIDs[1] != "k2" {
		t.Fatalf("unexpected quality knowledge ids: %#v", got.UsedKnowledgeIDs)
	}
	if len(got.UsedProvenanceHashes) != 2 || got.UsedProvenanceHashes[0] != "hash-a" || got.UsedProvenanceHashes[1] != "hash-b" {
		t.Fatalf("unexpected quality provenance hashes: %#v", got.UsedProvenanceHashes)
	}
}

func TestParsePlanResponseFallsBackToMarkdown(t *testing.T) {
	raw := "## Approach\nDo the thing.\n\n## Files\n- `a.go` - update logic"
	got := parsePlanResponse(raw)
	if got != raw {
		t.Fatalf("parsePlanResponse() = %q, want %q", got, raw)
	}
}

func TestParsePlanResponseKeepsRawJSONAsText(t *testing.T) {
	raw := `{"status":"completed","plan":"legacy"}`
	got := parsePlanResponse(raw)
	if got != raw {
		t.Fatalf("parsePlanResponse() = %q, want %q", got, raw)
	}
}
