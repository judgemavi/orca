package retro

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jasjeetmavi/orca/internal/driver"
	"github.com/jasjeetmavi/orca/internal/interaction"
	"github.com/jasjeetmavi/orca/internal/memory"
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
		"plan review feedback content",
		[]*memory.Entry{
			{
				ID:             "used-1",
				Content:        "Existing used memory entry",
				Category:       "pattern",
				Confidence:     0.9,
				ProvenanceHash: "hash-used-1",
			},
		},
		[]string{"k-1", "k-2"},
		[]string{"hash-1"},
		[]*memory.Entry{
			{
				ID:             "rel-1",
				Content:        "Related existing memory",
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
		"plan review feedback content",
		"- k-1",
		"- hash-1",
		"Existing used memory entry",
		"Related existing memory",
		"Output JSON array only.",
		"Do not rephrase",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("prompt missing %q", want)
		}
	}
}

func TestParseRetroEntries(t *testing.T) {
	raw := "```json\n[{\"content\":\" Keep edge-case tests \",\"category\":\"PATTERN\",\"tags\":[\"go\",\"testing\"],\"confidence\":0.82,\"file_paths\":[\" internal/retro/retro.go \",\"internal/retro/retro.go\"]}]\n```"
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
	if len(entries[0].FilePaths) != 1 || entries[0].FilePaths[0] != "internal/retro/retro.go" {
		t.Fatalf("file_paths = %v", entries[0].FilePaths)
	}
}

func TestRetroProvenanceHash(t *testing.T) {
	planText := "plan"
	runDiffs := "diff"
	reviewFeedback := "feedback"
	planReviewFeedback := "plan feedback"

	got := retroProvenanceHash(planText, runDiffs, reviewFeedback, planReviewFeedback)
	sum := sha256.Sum256([]byte(planText + "\n---\n" + runDiffs + "\n---\n" + reviewFeedback + "\n---\n" + planReviewFeedback))
	want := hex.EncodeToString(sum[:])
	if got != want {
		t.Fatalf("hash = %q, want %q", got, want)
	}
}

func TestRetroGeneratorRunCreatesMemoryAndSupersedes(t *testing.T) {
	db := testutil.DB(t)
	taskStore := task.NewStore(db)
	interactionStore := interaction.NewStore(db, t.TempDir())
	memoryStore := memory.NewStore(db)

	repoDir := initRetroTestRepo(t)

	tk, err := taskStore.Create("Retro Task", "Generate memory from a completed task", "")
	if err != nil {
		t.Fatalf("create task: %v", err)
	}

	oldEntry := &memory.Entry{
		Content:        "Legacy parser guidance",
		Category:       "pattern",
		Tags:           []string{"go", "parser"},
		Confidence:     0.7,
		ProvenanceHash: "legacy-hash",
	}
	if err := memoryStore.Create(oldEntry); err != nil {
		t.Fatalf("create old entry: %v", err)
	}

	planDiff := "1. Parse output\n2. Validate schema"
	planQuality := fmt.Sprintf(
		`{"used_memory_ids":["%s"],"used_provenance_hashes":["%s"]}`,
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
	if _, err := taskStore.AddReview(tk.ID, "Prefer parser boundary tests in plan", ""); err != nil {
		t.Fatalf("add plan review: %v", err)
	}

	output := fmt.Sprintf(
		`[{"content":"Prefer table-driven tests for parser boundaries","category":"pattern","tags":["go","testing"],"confidence":0.9,"supersedes":"%s","file_paths":["parser.go","missing.go"]}]`,
		oldEntry.ID,
	)
	generator := New(
		"retro-test-tool",
		&retroTestDriver{output: output},
		"retro-test-model",
		time.Minute,
		repoDir,
		memoryStore,
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

	currentEntries, err := memoryStore.List(memory.ListOpts{})
	if err != nil {
		t.Fatalf("list memory entries: %v", err)
	}
	if len(currentEntries) != 1 {
		t.Fatalf("list count = %d, want 1 (old entry superseded)", len(currentEntries))
	}
	newEntry := currentEntries[0]
	if newEntry.ID == oldEntry.ID {
		t.Fatalf("new entry id = old entry id %q", newEntry.ID)
	}
	if newEntry.SourceType != "retro" {
		t.Fatalf("source_type = %q, want %q", newEntry.SourceType, "retro")
	}
	if len(newEntry.FilePaths) != 1 || newEntry.FilePaths[0] != "parser.go" {
		t.Fatalf("file_paths = %v, want [parser.go]", newEntry.FilePaths)
	}

	taskInteractions, err := interactionStore.List(tk.ID)
	if err != nil {
		t.Fatalf("list task interactions: %v", err)
	}
	expectedHash := retroProvenanceHash(
		planDiff,
		collectRunDiffs(taskInteractions),
		collectReviewFeedback(taskInteractions),
		collectPlanReviewFeedback(mustListReviews(t, taskStore, tk.ID)),
	)
	if newEntry.ProvenanceHash != expectedHash {
		t.Fatalf("provenance_hash = %q, want %q", newEntry.ProvenanceHash, expectedHash)
	}

	oldReloaded, err := memoryStore.Get(oldEntry.ID)
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

	currentEntries, err = memoryStore.List(memory.ListOpts{})
	if err != nil {
		t.Fatalf("list memory entries after second run: %v", err)
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

func mustListReviews(t *testing.T, store *task.Store, taskID string) []task.TaskReview {
	t.Helper()
	reviews, err := store.ListReviews(taskID)
	if err != nil {
		t.Fatalf("list reviews: %v", err)
	}
	return reviews
}

func initRetroTestRepo(t *testing.T) string {
	t.Helper()
	repoDir := t.TempDir()
	runGit(t, repoDir, "init")
	runGit(t, repoDir, "config", "user.email", "test@example.com")
	runGit(t, repoDir, "config", "user.name", "Retro Test")
	writeRepoFile(t, repoDir, "parser.go", "package parser\n")
	runGit(t, repoDir, "add", "parser.go")
	runGit(t, repoDir, "commit", "-m", "init")
	return repoDir
}

func writeRepoFile(t *testing.T, repoDir, relPath, content string) {
	t.Helper()
	fullPath := filepath.Join(repoDir, relPath)
	if err := os.MkdirAll(filepath.Dir(fullPath), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", relPath, err)
	}
	if err := os.WriteFile(fullPath, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", relPath, err)
	}
}

func runGit(t *testing.T, repoDir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = repoDir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v failed: %v\n%s", args, err, string(out))
	}
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
