package retro

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jasjeetmavi/orca/internal/driver"
	"github.com/jasjeetmavi/orca/internal/interaction"
	"github.com/jasjeetmavi/orca/internal/knowledge"
	"github.com/jasjeetmavi/orca/internal/task"
	"github.com/jasjeetmavi/orca/internal/testutil"
)

func TestBuildRetroPrompt(t *testing.T) {
	prompt := buildRetroPrompt(
		"Task title",
		"Task description",
		"plan diff content",
		"run diff content",
		"review feedback content",
		[]*knowledge.Entry{
			{
				ID:             "used-1",
				Content:        "Existing used knowledge entry",
				Category:       "pattern",
				Confidence:     0.9,
				ProvenanceHash: "hash-used-1",
			},
		},
		[]string{"k-1", "k-2"},
		[]string{"hash-1"},
		[]*knowledge.Entry{
			{
				ID:             "rel-1",
				Content:        "Related existing knowledge",
				Category:       "pitfall",
				Confidence:     0.8,
				ProvenanceHash: "hash-rel-1",
			},
		},
	)

	for _, want := range []string{
		"Task title",
		"Task description",
		"plan diff content",
		"run diff content",
		"review feedback content",
		"- k-1",
		"- hash-1",
		"Existing used knowledge entry",
		"Related existing knowledge",
		"Output JSON array only.",
		"Do not rephrase",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("prompt missing %q", want)
		}
	}
}

func TestParseRetroEntries(t *testing.T) {
	raw := "```json\n[{\"content\":\" Keep edge-case tests \",\"category\":\"PATTERN\",\"tags\":[\"go\",\"testing\"],\"confidence\":0.82}]\n```"
	entries, err := parseRetroEntries(raw)
	if err != nil {
		t.Fatalf("parseRetroEntries: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("len(entries) = %d, want 1", len(entries))
	}
	if entries[0].Content != "Keep edge-case tests" {
		t.Fatalf("content = %q", entries[0].Content)
	}
	if entries[0].Category != "pattern" {
		t.Fatalf("category = %q, want %q", entries[0].Category, "pattern")
	}
}

func TestRetroProvenanceHash(t *testing.T) {
	planText := "plan"
	runDiffs := "diff"
	reviewFeedback := "feedback"

	got := retroProvenanceHash(planText, runDiffs, reviewFeedback)
	sum := sha256.Sum256([]byte(planText + "\n---\n" + runDiffs + "\n---\n" + reviewFeedback))
	want := hex.EncodeToString(sum[:])
	if got != want {
		t.Fatalf("hash = %q, want %q", got, want)
	}
}

func TestRetroGeneratorRunCreatesKnowledgeAndSupersedes(t *testing.T) {
	db := testutil.DB(t)
	taskStore := task.NewStore(db)
	interactionStore := interaction.NewStore(db, t.TempDir())
	knowledgeStore := knowledge.NewStore(db)

	tk, err := taskStore.Create("Retro Task", "Generate knowledge from a completed task", "")
	if err != nil {
		t.Fatalf("create task: %v", err)
	}

	oldEntry := &knowledge.Entry{
		Content:        "Legacy parser guidance",
		Category:       "pattern",
		Tags:           []string{"go", "parser"},
		Confidence:     0.7,
		ProvenanceHash: "legacy-hash",
	}
	if err := knowledgeStore.Create(oldEntry); err != nil {
		t.Fatalf("create old entry: %v", err)
	}

	planDiff := "1. Parse output\n2. Validate schema"
	planQuality := fmt.Sprintf(
		`{"used_knowledge_ids":["%s"],"used_provenance_hashes":["%s"]}`,
		oldEntry.ID,
		oldEntry.ProvenanceHash,
	)
	createCompletedInteraction(t, interactionStore, tk.ID, interaction.PhasePlan, planDiff, planQuality, "")
	createCompletedInteraction(t, interactionStore, tk.ID, interaction.PhaseRun, "diff --git a/parser.go b/parser.go\n+add parser validation", "", "")
	createCompletedInteraction(
		t,
		interactionStore,
		tk.ID,
		interaction.PhaseReview,
		"Review pointed out missing boundary tests",
		`{"approved":false,"feedback":"add parser edge-case tests"}`,
		"",
	)

	output := fmt.Sprintf(
		`[{"content":"Prefer table-driven tests for parser boundaries","category":"pattern","tags":["go","testing"],"confidence":0.9,"supersedes":"%s"}]`,
		oldEntry.ID,
	)
	generator := New(
		"retro-test-tool",
		&retroTestDriver{output: output},
		"retro-test-model",
		time.Minute,
		t.TempDir(),
		knowledgeStore,
		taskStore,
		interactionStore,
	)

	result, err := generator.Run(tk.ID)
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if result.CreatedCount != 1 {
		t.Fatalf("created_count = %d, want 1", result.CreatedCount)
	}
	if result.SkippedCount != 0 {
		t.Fatalf("skipped_count = %d, want 0", result.SkippedCount)
	}
	if len(result.CreatedEntryIDs) != 1 {
		t.Fatalf("created_entry_ids = %v, want len 1", result.CreatedEntryIDs)
	}

	currentEntries, err := knowledgeStore.List(knowledge.ListOpts{})
	if err != nil {
		t.Fatalf("list knowledge entries: %v", err)
	}
	if len(currentEntries) != 1 {
		t.Fatalf("list count = %d, want 1 (old entry superseded)", len(currentEntries))
	}
	newEntry := currentEntries[0]
	if newEntry.ID == oldEntry.ID {
		t.Fatalf("new entry id = old entry id %q", newEntry.ID)
	}

	taskInteractions, err := interactionStore.List(tk.ID)
	if err != nil {
		t.Fatalf("list task interactions: %v", err)
	}
	expectedHash := retroProvenanceHash(
		planDiff,
		collectRunDiffs(taskInteractions),
		collectReviewFeedback(taskInteractions),
	)
	if newEntry.ProvenanceHash != expectedHash {
		t.Fatalf("provenance_hash = %q, want %q", newEntry.ProvenanceHash, expectedHash)
	}

	oldReloaded, err := knowledgeStore.Get(oldEntry.ID)
	if err != nil {
		t.Fatalf("get old entry: %v", err)
	}
	if oldReloaded.SupersededBy != newEntry.ID {
		t.Fatalf("old entry superseded_by = %q, want %q", oldReloaded.SupersededBy, newEntry.ID)
	}

	second, err := generator.Run(tk.ID)
	if err != nil {
		t.Fatalf("second Run() error = %v", err)
	}
	if !second.DuplicateProvenance {
		t.Fatalf("duplicate_provenance = false, want true")
	}
	if second.CreatedCount != 0 || second.SkippedCount != 1 {
		t.Fatalf("second result counts = created:%d skipped:%d, want 0 and 1", second.CreatedCount, second.SkippedCount)
	}

	currentEntries, err = knowledgeStore.List(knowledge.ListOpts{})
	if err != nil {
		t.Fatalf("list knowledge entries after second run: %v", err)
	}
	if len(currentEntries) != 1 {
		t.Fatalf("list count after second run = %d, want 1", len(currentEntries))
	}

	retroInteractions, err := interactionStore.ListByPhase(tk.ID, interaction.PhaseRetro)
	if err != nil {
		t.Fatalf("list retro interactions: %v", err)
	}
	if len(retroInteractions) < 2 {
		t.Fatalf("retro interactions count = %d, want >= 2", len(retroInteractions))
	}
	var quality struct {
		CreatedCount        int  `json:"created_count"`
		SkippedCount        int  `json:"skipped_count"`
		DuplicateProvenance bool `json:"duplicate_provenance"`
	}
	if err := json.Unmarshal([]byte(retroInteractions[0].QualityJSON), &quality); err != nil {
		t.Fatalf("parse quality_json: %v", err)
	}
	if quality.CreatedCount != 0 || quality.SkippedCount != 1 || !quality.DuplicateProvenance {
		t.Fatalf(
			"quality_json counts = created:%d skipped:%d duplicate:%t, want 0 1 true",
			quality.CreatedCount,
			quality.SkippedCount,
			quality.DuplicateProvenance,
		)
	}
}

func createCompletedInteraction(
	t *testing.T,
	store *interaction.Store,
	taskID string,
	phase string,
	diff string,
	quality string,
	errText string,
) string {
	t.Helper()
	taskRef := taskID
	w, err := store.Begin(&taskRef, phase, "test-tool")
	if err != nil {
		t.Fatalf("begin interaction (%s): %v", phase, err)
	}
	opts := []interaction.FinishOption{}
	if strings.TrimSpace(diff) != "" {
		opts = append(opts, interaction.WithDiff(diff))
	}
	if strings.TrimSpace(quality) != "" {
		opts = append(opts, interaction.WithQuality(quality))
	}
	if strings.TrimSpace(errText) != "" {
		opts = append(opts, interaction.WithError(errText))
	}
	if err := store.Finish(w.ID(), "completed", opts...); err != nil {
		_ = w.Close()
		t.Fatalf("finish interaction (%s): %v", phase, err)
	}
	if err := w.Close(); err != nil {
		t.Fatalf("close interaction writer (%s): %v", phase, err)
	}
	return w.ID()
}

type retroTestDriver struct {
	output string
}

func (d *retroTestDriver) Name() string { return "retro-test-driver" }

func (d *retroTestDriver) Binary() string { return "sh" }

func (d *retroTestDriver) Models() []string { return nil }

func (d *retroTestDriver) HeadlessArgs(prompt, model, dir string) []string {
	script := "cat <<'EOF'\ntext:" + d.output + "\nEOF"
	return []string{"-c", script}
}

func (d *retroTestDriver) ResumeArgs(sessionID, feedback, model, dir string) []string {
	return d.HeadlessArgs("", model, dir)
}

func (d *retroTestDriver) ParseEvent(line []byte) (driver.Event, error) {
	text := strings.TrimSpace(string(line))
	if strings.HasPrefix(text, "text:") {
		return driver.Event{
			Type: driver.EventText,
			Text: strings.TrimPrefix(text, "text:"),
		}, nil
	}
	return driver.Event{}, fmt.Errorf("unknown line %q", text)
}

func (d *retroTestDriver) FormatEvent(line []byte) string { return string(line) }

func (d *retroTestDriver) ParseSessionID(_ []driver.Event) string { return "" }
