package plan

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/jasjeetmavi/orca/internal/memory"
	"github.com/jasjeetmavi/orca/prompts"
)

func TestBuildPlanPromptMemoryPlacement(t *testing.T) {
	contextSection := strings.Join([]string{
		"## Project Context",
		"",
		"Context line",
		"",
		"## Relevant Knowledge",
		"",
		"1. Prefer table-driven tests",
	}, "\n")

	prompt := buildPlanPrompt(contextSection, "Task title", "Task description")
	prefix := strings.TrimSpace(prompts.OutputStyle) + "\n\n---\n\n"
	if !strings.HasPrefix(prompt, prefix) {
		t.Fatalf("prompt missing output style prefix")
	}

	contextIdx := strings.Index(prompt, "## Project Context")
	memoryIdx := strings.Index(prompt, "## Relevant Knowledge")
	taskIdx := strings.Index(prompt, "## Task")
	if contextIdx == -1 || memoryIdx == -1 || taskIdx == -1 {
		t.Fatalf("prompt missing expected sections: context=%d memory=%d task=%d", contextIdx, memoryIdx, taskIdx)
	}
	if !(contextIdx < memoryIdx && memoryIdx < taskIdx) {
		t.Fatalf("expected context -> memory -> task section order")
	}
}

func TestBuildMemorySectionAndQualityJSON(t *testing.T) {
	entries := []*memory.Entry{
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

	section, ids, hashes := buildMemorySection(entries)
	if !strings.Contains(section, "## Relevant Memory") {
		t.Fatalf("memory section heading missing")
	}
	if !strings.Contains(section, "Use retries for transient API failures.") {
		t.Fatalf("memory section missing first entry content")
	}
	if !strings.Contains(section, "Prefer explicit timeouts in network clients.") {
		t.Fatalf("memory section missing second entry content")
	}

	if len(ids) != 2 || ids[0] != "k1" || ids[1] != "k2" {
		t.Fatalf("unexpected memory ids: %#v", ids)
	}
	if len(hashes) != 2 || hashes[0] != "hash-a" || hashes[1] != "hash-b" {
		t.Fatalf("unexpected provenance hashes: %#v", hashes)
	}

	qualityJSON, err := buildMemoryQualityJSON(
		[]string{"k1", "k2", "k1", "   "},
		[]string{"hash-a", "hash-b", "hash-a"},
	)
	if err != nil {
		t.Fatalf("build quality json: %v", err)
	}

	var got memoryUsageMetadata
	if err := json.Unmarshal([]byte(qualityJSON), &got); err != nil {
		t.Fatalf("unmarshal quality json: %v", err)
	}
	if len(got.UsedMemoryIDs) != 2 || got.UsedMemoryIDs[0] != "k1" || got.UsedMemoryIDs[1] != "k2" {
		t.Fatalf("unexpected quality memory ids: %#v", got.UsedMemoryIDs)
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

func TestExtractPlanFilePaths(t *testing.T) {
	plan := `
## Implementation Plan
1. Update internal/api/server.go.
2. Add tests in internal/api/server_test.go
3. Touch web/src/routes/memory.tsx and README.md
4. Ignore https://example.com/docs.md
`

	paths := extractPlanFilePaths(plan)
	joined := strings.Join(paths, ",")
	if !strings.Contains(joined, "internal/api/server.go") {
		t.Fatalf("missing server.go in paths: %v", paths)
	}
	if !strings.Contains(joined, "internal/api/server_test.go") {
		t.Fatalf("missing server_test.go in paths: %v", paths)
	}
	if !strings.Contains(joined, "web/src/routes/memory.tsx") {
		t.Fatalf("missing memory.tsx in paths: %v", paths)
	}
	if !strings.Contains(joined, "README.md") {
		t.Fatalf("missing README.md in paths: %v", paths)
	}
	if strings.Contains(joined, "https://example.com/docs.md") {
		t.Fatalf("unexpected url path in paths: %v", paths)
	}
}
