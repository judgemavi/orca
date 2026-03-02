package memory

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jasjeetmavi/orca/internal/diffclass"
)

func TestSyncFirstRunSetsHeadOnly(t *testing.T) {
	repoDir := initGitRepoWithCommit(t, map[string]string{
		"internal/app.go": "package app\n",
	})

	store, db := setupStore(t)
	syncer := NewSyncer(store, db.DB, repoDir, "", nil, "", time.Minute)
	head := gitOutput(t, repoDir, "rev-parse", "HEAD")

	result, err := syncer.Sync()
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if result.LastCommit != "" {
		t.Fatalf("last_commit = %q, want empty", result.LastCommit)
	}
	if result.NewCommit != head {
		t.Fatalf("new_commit = %q, want %q", result.NewCommit, head)
	}
	if result.CommitCount != 0 {
		t.Fatalf("commit_count = %d, want 0", result.CommitCount)
	}
	if result.FlaggedEntries != 0 {
		t.Fatalf("flagged_entries = %d, want 0", result.FlaggedEntries)
	}

	last, err := syncer.GetLastSyncedCommit()
	if err != nil {
		t.Fatalf("get last synced commit: %v", err)
	}
	if last != head {
		t.Fatalf("stored last_synced_commit = %q, want %q", last, head)
	}
}

func TestSyncNoOpWhenHeadUnchanged(t *testing.T) {
	repoDir := initGitRepoWithCommit(t, map[string]string{
		"internal/app.go": "package app\n",
	})

	store, db := setupStore(t)
	syncer := NewSyncer(store, db.DB, repoDir, "", nil, "", time.Minute)
	head := gitOutput(t, repoDir, "rev-parse", "HEAD")
	if err := syncer.SetLastSyncedCommit(head); err != nil {
		t.Fatalf("seed last synced commit: %v", err)
	}

	result, err := syncer.Sync()
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if result.LastCommit != head || result.NewCommit != head {
		t.Fatalf("commit range = %q..%q, want %q..%q", result.LastCommit, result.NewCommit, head, head)
	}
	if result.CommitCount != 0 || len(result.AffectedFiles) != 0 || result.FlaggedEntries != 0 {
		t.Fatalf("unexpected no-op result: %#v", result)
	}
}

func TestSyncClassifiesAndFlagsEntries(t *testing.T) {
	initialGoMod := buildLargeConfig("v1")
	repoDir := initGitRepoWithCommit(t, map[string]string{
		"go.mod":              initialGoMod,
		"internal/retro.go":   "package main\n\nfunc retroValue() int { return 1 }\n",
		"internal/deleted.go": "package main\n",
		"internal/other.go":   "package main\n",
	})

	store, db := setupStore(t)
	syncer := NewSyncer(store, db.DB, repoDir, "", nil, "", time.Minute)

	retro := mustCreateEntryWithOptions(t, store, "retro", "pattern", []string{"sync"}, 1.0, "hash-sync-retro", "retro", []string{"internal/retro.go"})
	majorEntry := mustCreateEntryWithOptions(t, store, "major", "architecture", []string{"sync"}, 1.0, "hash-sync-major", "explore", []string{"go.mod"})
	deletedEntry := mustCreateEntryWithOptions(t, store, "deleted", "pattern", []string{"sync"}, 1.0, "hash-sync-deleted", "explore", []string{"internal/deleted.go"})
	unaffected := mustCreateEntryWithOptions(t, store, "other", "pattern", []string{"sync"}, 1.0, "hash-sync-other", "retro", []string{"internal/other.go"})

	last := gitOutput(t, repoDir, "rev-parse", "HEAD")
	if err := syncer.SetLastSyncedCommit(last); err != nil {
		t.Fatalf("set last commit: %v", err)
	}

	writeRepoFile(t, repoDir, "internal/retro.go", "package main\n\nfunc retroValue() int { return 2 }\n")
	writeRepoFile(t, repoDir, "go.mod", buildLargeConfig("v2"))
	if err := os.Remove(filepath.Join(repoDir, "internal/deleted.go")); err != nil {
		t.Fatalf("remove deleted file: %v", err)
	}
	runGit(t, repoDir, "add", "internal/retro.go", "go.mod")
	runGit(t, repoDir, "rm", "internal/deleted.go")
	runGit(t, repoDir, "commit", "-m", "change tracked files")
	head := gitOutput(t, repoDir, "rev-parse", "HEAD")

	result, err := syncer.Sync()
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if result.CommitCount != 1 {
		t.Fatalf("commit_count = %d, want 1", result.CommitCount)
	}
	if result.FlaggedEntries != 3 {
		t.Fatalf("flagged_entries = %d, want 3", result.FlaggedEntries)
	}
	if len(result.AffectedFiles) != 3 {
		t.Fatalf("affected_files len = %d, want 3", len(result.AffectedFiles))
	}
	if result.StaleEntries != 1 {
		t.Fatalf("stale_entries = %d, want 1", result.StaleEntries)
	}
	if result.SupersededCount != 1 {
		t.Fatalf("superseded_count = %d, want 1", result.SupersededCount)
	}
	if result.Classifications["internal/retro.go"] != diffclass.ChangeMinor {
		t.Fatalf("classification internal/retro.go = %q, want %q", result.Classifications["internal/retro.go"], diffclass.ChangeMinor)
	}
	if result.Classifications["go.mod"] != diffclass.ChangeMajor {
		t.Fatalf("classification go.mod = %q, want %q", result.Classifications["go.mod"], diffclass.ChangeMajor)
	}
	if result.Classifications["internal/deleted.go"] != diffclass.ChangeDeleted {
		t.Fatalf("classification internal/deleted.go = %q, want %q", result.Classifications["internal/deleted.go"], diffclass.ChangeDeleted)
	}

	gotRetro, err := store.Get(retro.ID)
	if err != nil {
		t.Fatalf("get retro: %v", err)
	}
	if gotRetro.Confidence != 0.95 {
		t.Fatalf("retro confidence = %v, want 0.95", gotRetro.Confidence)
	}
	if gotRetro.CoveredAtCommit != head {
		t.Fatalf("retro covered_at_commit = %q, want %q", gotRetro.CoveredAtCommit, head)
	}

	gotMajor, err := store.Get(majorEntry.ID)
	if err != nil {
		t.Fatalf("get major entry: %v", err)
	}
	if !gotMajor.Stale {
		t.Fatal("major entry stale = false, want true")
	}
	if gotMajor.Confidence != 0.7 {
		t.Fatalf("major entry confidence = %v, want 0.7", gotMajor.Confidence)
	}

	gotDeleted, err := store.Get(deletedEntry.ID)
	if err != nil {
		t.Fatalf("get deleted entry: %v", err)
	}
	if gotDeleted.SupersededBy != deletedEntry.ID {
		t.Fatalf("deleted superseded_by = %q, want self id %q", gotDeleted.SupersededBy, deletedEntry.ID)
	}

	gotUnaffected, err := store.Get(unaffected.ID)
	if err != nil {
		t.Fatalf("get unaffected: %v", err)
	}
	if gotUnaffected.Confidence != 1.0 {
		t.Fatalf("unaffected confidence = %v, want 1.0", gotUnaffected.Confidence)
	}
}

func TestSyncStatusIncludesCommitLagAndContextStale(t *testing.T) {
	repoDir := initGitRepoWithCommit(t, map[string]string{
		"internal/app.go": "package app\n",
	})

	store, db := setupStore(t)
	syncer := NewSyncer(store, db.DB, repoDir, "", nil, "", time.Minute)

	if err := syncer.SetContextStaleFlag(true); err != nil {
		t.Fatalf("set context stale flag: %v", err)
	}

	status, err := syncer.Status()
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	if !status.SyncNeeded {
		t.Fatalf("sync_needed = false, want true when never synced")
	}
	if !status.ContextStale {
		t.Fatalf("context_stale = false, want true")
	}

	head := gitOutput(t, repoDir, "rev-parse", "HEAD")
	if err := syncer.SetLastSyncedCommit(head); err != nil {
		t.Fatalf("set last synced commit: %v", err)
	}
	if err := syncer.SetContextStaleFlag(false); err != nil {
		t.Fatalf("clear context stale flag: %v", err)
	}

	writeRepoFile(t, repoDir, "internal/app.go", "package app\n// changed\n")
	runGit(t, repoDir, "add", "internal/app.go")
	runGit(t, repoDir, "commit", "-m", "change")

	status, err = syncer.Status()
	if err != nil {
		t.Fatalf("status after change: %v", err)
	}
	if !status.SyncNeeded {
		t.Fatalf("sync_needed = false, want true")
	}
	if status.CommitsBehind != 1 {
		t.Fatalf("commits_behind = %d, want 1", status.CommitsBehind)
	}
}

func TestSyncAcrossMultipleCommitsUsesRangeDiff(t *testing.T) {
	repoDir := initGitRepoWithCommit(t, map[string]string{
		"internal/retro.go": "package main\n\nfunc retroValue() int { return 1 }\n",
	})
	store, db := setupStore(t)
	syncer := NewSyncer(store, db.DB, repoDir, "", nil, "", time.Minute)
	entry := mustCreateEntryWithOptions(t, store, "retro", "pattern", []string{"sync"}, 1.0, "hash-sync-range", "retro", []string{"internal/retro.go"})

	base := gitOutput(t, repoDir, "rev-parse", "HEAD")
	if err := syncer.SetLastSyncedCommit(base); err != nil {
		t.Fatalf("set last synced commit: %v", err)
	}

	writeRepoFile(t, repoDir, "internal/retro.go", "package main\n\nfunc retroValue() int {\n\treturn 2\n}\n"+strings.Repeat("// line\n", 15))
	runGit(t, repoDir, "add", "internal/retro.go")
	runGit(t, repoDir, "commit", "-m", "change one")

	writeRepoFile(t, repoDir, "internal/retro.go", "package main\n\nfunc retroValue() int {\n\treturn 3\n}\n"+strings.Repeat("// line\n", 30))
	runGit(t, repoDir, "add", "internal/retro.go")
	runGit(t, repoDir, "commit", "-m", "change two")
	head := gitOutput(t, repoDir, "rev-parse", "HEAD")

	result, err := syncer.Sync()
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if result.CommitCount != 2 {
		t.Fatalf("commit_count = %d, want 2", result.CommitCount)
	}
	if result.Classifications["internal/retro.go"] != diffclass.ChangeMedium {
		t.Fatalf("classification = %q, want %q", result.Classifications["internal/retro.go"], diffclass.ChangeMedium)
	}
	if result.StaleEntries != 0 {
		t.Fatalf("stale_entries = %d, want 0", result.StaleEntries)
	}

	reloaded, err := store.Get(entry.ID)
	if err != nil {
		t.Fatalf("get entry: %v", err)
	}
	if reloaded.Stale {
		t.Fatal("stale = true, want false")
	}
	if reloaded.CoveredAtCommit != head {
		t.Fatalf("covered_at_commit = %q, want %q", reloaded.CoveredAtCommit, head)
	}
	if reloaded.Confidence != 0.85 {
		t.Fatalf("confidence = %v, want 0.85", reloaded.Confidence)
	}
}

func TestSyncRenameUpdatesFileAssociations(t *testing.T) {
	repoDir := initGitRepoWithCommit(t, map[string]string{
		"internal/old_name.go": "package main\n\nfunc Value() int { return 1 }\n",
	})
	store, db := setupStore(t)
	syncer := NewSyncer(store, db.DB, repoDir, "", nil, "", time.Minute)
	entry := mustCreateEntryWithOptions(t, store, "rename", "pattern", []string{"sync"}, 1.0, "hash-sync-rename", "retro", []string{"internal/old_name.go"})

	base := gitOutput(t, repoDir, "rev-parse", "HEAD")
	if err := syncer.SetLastSyncedCommit(base); err != nil {
		t.Fatalf("set last synced commit: %v", err)
	}

	runGit(t, repoDir, "mv", "internal/old_name.go", "internal/new_name.go")
	runGit(t, repoDir, "commit", "-m", "rename tracked file")
	head := gitOutput(t, repoDir, "rev-parse", "HEAD")

	result, err := syncer.Sync()
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if result.FlaggedEntries != 1 {
		t.Fatalf("flagged_entries = %d, want 1", result.FlaggedEntries)
	}
	if result.Classifications["internal/old_name.go"] != diffclass.ChangeRenamed {
		t.Fatalf("classification = %q, want %q", result.Classifications["internal/old_name.go"], diffclass.ChangeRenamed)
	}

	reloaded, err := store.Get(entry.ID)
	if err != nil {
		t.Fatalf("get entry: %v", err)
	}
	if len(reloaded.FilePaths) != 1 || reloaded.FilePaths[0] != "internal/new_name.go" {
		t.Fatalf("file paths = %v, want [internal/new_name.go]", reloaded.FilePaths)
	}
	if reloaded.CoveredAtCommit != head {
		t.Fatalf("covered_at_commit = %q, want %q", reloaded.CoveredAtCommit, head)
	}
	if reloaded.Confidence != 1.0 {
		t.Fatalf("confidence = %v, want 1.0", reloaded.Confidence)
	}
}

func TestRefreshWithoutChangesClearsStale(t *testing.T) {
	repoDir := initGitRepoWithCommit(t, map[string]string{
		"internal/app.go": "package app\n\nfunc Value() int { return 1 }\n",
	})
	store, db := setupStore(t)
	syncer := NewSyncer(store, db.DB, repoDir, "", nil, "", time.Minute)
	head := gitOutput(t, repoDir, "rev-parse", "HEAD")
	entry := mustCreateEntryWithOptions(t, store, "stale", "pattern", []string{"sync"}, 1.0, "hash-sync-refresh", "retro", []string{"internal/app.go"})
	if err := store.Update(entry.ID, UpdateFields{Stale: Ptr(true), CoveredAtCommit: Ptr(head)}); err != nil {
		t.Fatalf("mark stale: %v", err)
	}

	result, err := syncer.Refresh(entry.ID)
	if err != nil {
		t.Fatalf("refresh: %v", err)
	}
	if result.Updated != 1 || result.Skipped != 0 {
		t.Fatalf("refresh result = %+v, want updated=1 skipped=0", result)
	}
	reloaded, err := store.Get(entry.ID)
	if err != nil {
		t.Fatalf("get entry: %v", err)
	}
	if reloaded.Stale {
		t.Fatal("stale = true, want false")
	}
}

func TestRefreshWithoutLLMSkipsChangedStaleEntry(t *testing.T) {
	repoDir := initGitRepoWithCommit(t, map[string]string{
		"internal/app.go": "package app\n\nfunc Value() int { return 1 }\n",
	})
	store, db := setupStore(t)
	syncer := NewSyncer(store, db.DB, repoDir, "", nil, "", time.Minute)
	base := gitOutput(t, repoDir, "rev-parse", "HEAD")
	entry := mustCreateEntryWithOptions(t, store, "stale", "pattern", []string{"sync"}, 1.0, "hash-sync-refresh-llm", "retro", []string{"internal/app.go"})
	if err := store.Update(entry.ID, UpdateFields{Stale: Ptr(true), CoveredAtCommit: Ptr(base)}); err != nil {
		t.Fatalf("mark stale: %v", err)
	}

	writeRepoFile(t, repoDir, "internal/app.go", "package app\n\nfunc Value() int { return 2 }\n")
	runGit(t, repoDir, "add", "internal/app.go")
	runGit(t, repoDir, "commit", "-m", "change app")

	result, err := syncer.Refresh(entry.ID)
	if err != nil {
		t.Fatalf("refresh: %v", err)
	}
	if result.Updated != 0 || result.Skipped != 1 {
		t.Fatalf("refresh result = %+v, want updated=0 skipped=1", result)
	}
	reloaded, err := store.Get(entry.ID)
	if err != nil {
		t.Fatalf("get entry: %v", err)
	}
	if !reloaded.Stale {
		t.Fatal("stale = false, want true when llm refresh unavailable")
	}
}

func buildLargeConfig(version string) string {
	var sb strings.Builder
	sb.WriteString("module example.com/orca\n\ngo 1.22\n\n")
	for i := 0; i < 140; i++ {
		sb.WriteString("require example.com/lib")
		sb.WriteString(version)
		sb.WriteString("/")
		sb.WriteString(strings.Repeat("x", i%7+1))
		sb.WriteString(" v0.0.1\n")
	}
	return sb.String()
}

func initGitRepoWithCommit(t *testing.T, files map[string]string) string {
	t.Helper()
	repoDir := t.TempDir()
	runGit(t, repoDir, "init")
	runGit(t, repoDir, "config", "user.email", "test@example.com")
	runGit(t, repoDir, "config", "user.name", "Orca Test")
	for path, content := range files {
		writeRepoFile(t, repoDir, path, content)
	}
	args := []string{"add"}
	for path := range files {
		args = append(args, path)
	}
	runGit(t, repoDir, args...)
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
		t.Fatalf("git %v failed: %v\n%s", args, err, strings.TrimSpace(string(out)))
	}
}

func gitOutput(t *testing.T, repoDir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = repoDir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v failed: %v\n%s", args, err, strings.TrimSpace(string(out)))
	}
	return strings.TrimSpace(string(out))
}
