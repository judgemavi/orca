package explore

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jasjeetmavi/orca/internal/memory"
	"github.com/jasjeetmavi/orca/internal/state"
)

func TestWriteManualContextWritesToDBOnly(t *testing.T) {
	repoDir := initTempGitRepo(t)

	outPath, err := WriteManualContext(repoDir, "db-content")
	if err != nil {
		t.Fatalf("WriteManualContext() error = %v", err)
	}
	if outPath != stateDBFile {
		t.Fatalf("WriteManualContext() path = %q, want %q", outPath, stateDBFile)
	}

	if _, err := os.Stat(filepath.Join(repoDir, ".orca", "context.md")); !os.IsNotExist(err) {
		t.Fatalf("context.md should not exist, stat err = %v", err)
	}

	db := setupStateDB(t, repoDir)
	var got string
	if err := db.QueryRow(`SELECT content FROM explore_context WHERE id = 1`).Scan(&got); err != nil {
		t.Fatalf("query explore_context: %v", err)
	}
	if got != "db-content" {
		t.Fatalf("db content = %q, want %q", got, "db-content")
	}
}

func TestHasTrackedCodeFalseForConfigOnlyAndOrcaFiles(t *testing.T) {
	repoDir := initEmptyGitRepo(t)

	if err := os.WriteFile(filepath.Join(repoDir, ".gitignore"), []byte("node_modules/\n"), 0o644); err != nil {
		t.Fatalf("WriteFile(.gitignore) error = %v", err)
	}
	if err := os.WriteFile(filepath.Join(repoDir, "LICENSE"), []byte("license"), 0o644); err != nil {
		t.Fatalf("WriteFile(LICENSE) error = %v", err)
	}
	if err := os.MkdirAll(filepath.Join(repoDir, ".orca"), 0o755); err != nil {
		t.Fatalf("MkdirAll(.orca) error = %v", err)
	}
	if err := os.WriteFile(filepath.Join(repoDir, ".orca", "context.md"), []byte("internal state"), 0o644); err != nil {
		t.Fatalf("WriteFile(.orca/context.md) error = %v", err)
	}
	runGit(t, repoDir, "add", ".gitignore", "LICENSE", ".orca/context.md")

	hasCode, err := HasTrackedCode(repoDir)
	if err != nil {
		t.Fatalf("HasTrackedCode() error = %v", err)
	}
	if hasCode {
		t.Fatal("HasTrackedCode() = true, want false")
	}
}

func TestHasTrackedCodeTrueWhenSourceTracked(t *testing.T) {
	repoDir := initEmptyGitRepo(t)

	if err := os.WriteFile(filepath.Join(repoDir, ".gitignore"), []byte("node_modules/\n"), 0o644); err != nil {
		t.Fatalf("WriteFile(.gitignore) error = %v", err)
	}
	if err := os.WriteFile(filepath.Join(repoDir, "main.go"), []byte("package main\n"), 0o644); err != nil {
		t.Fatalf("WriteFile(main.go) error = %v", err)
	}
	runGit(t, repoDir, "add", ".gitignore", "main.go")

	hasCode, err := HasTrackedCode(repoDir)
	if err != nil {
		t.Fatalf("HasTrackedCode() error = %v", err)
	}
	if !hasCode {
		t.Fatal("HasTrackedCode() = false, want true")
	}
}

func TestHasTrackedCodeReturnsErrorOutsideGitRepo(t *testing.T) {
	repoDir := t.TempDir()
	if _, err := HasTrackedCode(repoDir); err == nil {
		t.Fatal("HasTrackedCode() error = nil, want non-nil")
	}
}

func TestLoadContextReturnsDBContent(t *testing.T) {
	repoDir := initTempGitRepo(t)

	if _, err := WriteManualContext(repoDir, "db-content"); err != nil {
		t.Fatalf("WriteManualContext() error = %v", err)
	}

	got := LoadContext(repoDir)
	if got != "db-content" {
		t.Fatalf("LoadContext() = %q, want %q", got, "db-content")
	}
}

func TestLoadContextIgnoresLegacyContextFile(t *testing.T) {
	repoDir := initTempGitRepo(t)

	if err := os.MkdirAll(filepath.Join(repoDir, ".orca"), 0o755); err != nil {
		t.Fatalf("MkdirAll(.orca) error = %v", err)
	}
	if err := os.WriteFile(filepath.Join(repoDir, ".orca", "context.md"), []byte("legacy-file-content"), 0o644); err != nil {
		t.Fatalf("WriteFile(context.md) error = %v", err)
	}

	got := LoadContext(repoDir)
	if got != "" {
		t.Fatalf("LoadContext() = %q, want empty string", got)
	}
}

func TestIsStaleFalseAfterManualContextWrite(t *testing.T) {
	repoDir := initTempGitRepo(t)

	if _, err := WriteManualContext(repoDir, "context"); err != nil {
		t.Fatalf("WriteManualContext() error = %v", err)
	}

	stale, err := IsStale(repoDir)
	if err != nil {
		t.Fatalf("IsStale() error = %v", err)
	}
	if stale {
		t.Fatal("IsStale() = true, want false")
	}
}

func TestIsStaleTrueAfterTrackedFileTreeChange(t *testing.T) {
	repoDir := initTempGitRepo(t)

	if _, err := WriteManualContext(repoDir, "context"); err != nil {
		t.Fatalf("WriteManualContext() error = %v", err)
	}

	newPath := filepath.Join(repoDir, "new.txt")
	if err := os.WriteFile(newPath, []byte("new"), 0o644); err != nil {
		t.Fatalf("WriteFile(new.txt) error = %v", err)
	}
	runGit(t, repoDir, "add", "new.txt")

	stale, err := IsStale(repoDir)
	if err != nil {
		t.Fatalf("IsStale() error = %v", err)
	}
	if !stale {
		t.Fatal("IsStale() = false, want true")
	}
}

func TestIsStaleFalseWhenNoContextRow(t *testing.T) {
	repoDir := initTempGitRepo(t)
	_ = setupStateDB(t, repoDir)

	stale, err := IsStale(repoDir)
	if err != nil {
		t.Fatalf("IsStale() error = %v", err)
	}
	if stale {
		t.Fatal("IsStale() = true, want false when explore_context row is missing")
	}
}

func TestContextAgeNonZeroWhenContextExists(t *testing.T) {
	repoDir := initTempGitRepo(t)

	if _, err := WriteManualContext(repoDir, "context"); err != nil {
		t.Fatalf("WriteManualContext() error = %v", err)
	}

	age := ContextAge(repoDir)
	if age <= 0 {
		t.Fatalf("ContextAge() = %v, want > 0", age)
	}
}

func TestContextAgeZeroWhenContextMissing(t *testing.T) {
	repoDir := initTempGitRepo(t)
	_ = setupStateDB(t, repoDir)

	age := ContextAge(repoDir)
	if age != 0 {
		t.Fatalf("ContextAge() = %v, want 0", age)
	}
}

func TestLoadContextFromDB(t *testing.T) {
	repoDir := initTempGitRepo(t)
	db := setupStateDB(t, repoDir)

	if _, err := db.Exec(
		`REPLACE INTO explore_context (id, content, hash, updated_at) VALUES (1, 'from-db', 'h', CURRENT_TIMESTAMP)`,
	); err != nil {
		t.Fatalf("seed explore_context: %v", err)
	}

	got := LoadContextFromDB(db)
	if got != "from-db" {
		t.Fatalf("LoadContextFromDB() = %q, want %q", got, "from-db")
	}
}

func TestExtractMemoryExtractionAndStripSection(t *testing.T) {
	raw := strings.TrimSpace(strings.Join([]string{
		"## Project Context",
		"",
		"Useful context.",
		"",
		"## Memory Extraction",
		"",
		"```json",
		`[{"content":"Use layered boundaries","category":"architecture","tags":["arch"],"confidence":0.95,"file_paths":["internal/app.go"]}]`,
		"```",
	}, "\n"))

	entries, err := extractMemoryExtraction(raw)
	if err != nil {
		t.Fatalf("extractMemoryExtraction: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("len(entries) = %d, want 1", len(entries))
	}
	if entries[0].Category != "architecture" {
		t.Fatalf("category = %q, want architecture", entries[0].Category)
	}

	stripped := stripMemoryExtractionSection(raw)
	if strings.Contains(stripped, "## Memory Extraction") {
		t.Fatalf("stripped output still contains memory extraction section:\n%s", stripped)
	}
	if !strings.Contains(stripped, "## Project Context") {
		t.Fatalf("stripped output lost context section:\n%s", stripped)
	}
}

func TestSeedMemoryCreatesExploreEntriesAndSupersedesOld(t *testing.T) {
	repoDir := initEmptyGitRepo(t)
	writeRepoFile(t, repoDir, "internal/app.go", "package app\n")
	runGit(t, repoDir, "add", "internal/app.go")
	runGit(t, repoDir, "commit", "-m", "seed file")

	db := setupStateDB(t, repoDir)
	store := memory.NewStore(db)

	old := &memory.Entry{
		Content:        "Old seeded context",
		Category:       "pattern",
		Tags:           []string{"explore-seed", "old"},
		SourceType:     "explore",
		FilePaths:      []string{"internal/app.go"},
		Confidence:     0.9,
		ProvenanceHash: "old-seed-hash",
	}
	if err := store.Create(old); err != nil {
		t.Fatalf("create old seed entry: %v", err)
	}
	oldSummary := &memory.Entry{
		Content:        "Old summary",
		Category:       "architecture",
		Tags:           []string{"project-summary"},
		SourceType:     "explore",
		Confidence:     0.9,
		ProvenanceHash: "old-summary-hash",
	}
	if err := store.Create(oldSummary); err != nil {
		t.Fatalf("create old summary entry: %v", err)
	}

	explorer := &Explorer{repoDir: repoDir, memory: store}
	err := explorer.seedMemory("context", []extractedMemoryEntry{
		{
			Content:    "Use package boundaries for handlers",
			Category:   "architecture",
			Tags:       []string{"api"},
			Confidence: 0.95,
			FilePaths:  []string{"internal/app.go", "missing.go"},
		},
	})
	if err != nil {
		t.Fatalf("seedMemory: %v", err)
	}

	current, err := store.List(memory.ListOpts{})
	if err != nil {
		t.Fatalf("list memory: %v", err)
	}
	if len(current) != 2 {
		t.Fatalf("list len = %d, want 2 non-superseded entries", len(current))
	}
	var seedEntry, summaryEntry *memory.Entry
	for _, entry := range current {
		switch {
		case contains(entry.Tags, "explore-seed"):
			seedEntry = entry
		case contains(entry.Tags, "project-summary"):
			summaryEntry = entry
		}
	}
	if seedEntry == nil {
		t.Fatalf("expected explore-seed entry in %v", current)
	}
	if summaryEntry == nil {
		t.Fatalf("expected project-summary entry in %v", current)
	}
	if seedEntry.SourceType != "explore" || summaryEntry.SourceType != "explore" {
		t.Fatalf("source types = %q,%q, want explore", seedEntry.SourceType, summaryEntry.SourceType)
	}
	if len(seedEntry.FilePaths) != 1 || seedEntry.FilePaths[0] != "internal/app.go" {
		t.Fatalf("file_paths = %v, want [internal/app.go]", seedEntry.FilePaths)
	}

	oldReloaded, err := store.Get(old.ID)
	if err != nil {
		t.Fatalf("get old entry: %v", err)
	}
	if oldReloaded.SupersededBy != seedEntry.ID {
		t.Fatalf("old superseded_by = %q, want %q", oldReloaded.SupersededBy, seedEntry.ID)
	}

	oldSummaryReloaded, err := store.Get(oldSummary.ID)
	if err != nil {
		t.Fatalf("get old summary entry: %v", err)
	}
	if oldSummaryReloaded.SupersededBy != summaryEntry.ID {
		t.Fatalf("old summary superseded_by = %q, want %q", oldSummaryReloaded.SupersededBy, summaryEntry.ID)
	}
}

func initTempGitRepo(t *testing.T) string {
	t.Helper()

	repoDir := initEmptyGitRepo(t)

	readme := filepath.Join(repoDir, "README.md")
	if err := os.WriteFile(readme, []byte("hello"), 0o644); err != nil {
		t.Fatalf("WriteFile(README.md) error = %v", err)
	}
	runGit(t, repoDir, "add", "README.md")

	return repoDir
}

func initEmptyGitRepo(t *testing.T) string {
	t.Helper()

	repoDir := t.TempDir()
	runGit(t, repoDir, "init")
	return repoDir
}

func setupStateDB(t *testing.T, repoDir string) *state.DB {
	t.Helper()

	statePath := filepath.Join(repoDir, ".orca", "state.db")
	if err := os.MkdirAll(filepath.Dir(statePath), 0o755); err != nil {
		t.Fatalf("MkdirAll(state db dir) error = %v", err)
	}
	db, err := state.Open(statePath)
	if err != nil {
		t.Fatalf("state.Open() error = %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func runGit(t *testing.T, repoDir string, args ...string) {
	t.Helper()

	cmd := exec.Command("git", args...)
	cmd.Dir = repoDir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v failed: %v; output: %s", args, err, string(out))
	}
}

func writeRepoFile(t *testing.T, repoDir, relPath, content string) {
	t.Helper()
	fullPath := filepath.Join(repoDir, relPath)
	if err := os.MkdirAll(filepath.Dir(fullPath), 0o755); err != nil {
		t.Fatalf("MkdirAll(%s) error = %v", relPath, err)
	}
	if err := os.WriteFile(fullPath, []byte(content), 0o644); err != nil {
		t.Fatalf("WriteFile(%s) error = %v", relPath, err)
	}
}

func contains(items []string, needle string) bool {
	for _, item := range items {
		if strings.TrimSpace(item) == needle {
			return true
		}
	}
	return false
}
