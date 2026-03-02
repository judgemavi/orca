package memory

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
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

func TestSyncAppliesSourceTypePolicies(t *testing.T) {
	repoDir := initGitRepoWithCommit(t, map[string]string{
		"internal/retro.go":  "package main\n",
		"internal/task.go":   "package main\n",
		"internal/commit.go": "package main\n",
		"internal/other.go":  "package main\n",
	})

	store, db := setupStore(t)
	syncer := NewSyncer(store, db.DB, repoDir, "", nil, "", time.Minute)

	retro := mustCreateEntryWithOptions(t, store, "retro", "pattern", []string{"sync"}, 1.0, "hash-sync-retro", "retro", []string{"internal/retro.go"})
	taskEntry := mustCreateEntryWithOptions(t, store, "task", "pattern", []string{"sync"}, 1.0, "hash-sync-task", "task", []string{"internal/task.go"})
	commitEntry := mustCreateEntryWithOptions(t, store, "commit", "pattern", []string{"sync"}, 1.0, "hash-sync-commit", "commit", []string{"internal/commit.go"})
	unaffected := mustCreateEntryWithOptions(t, store, "other", "pattern", []string{"sync"}, 1.0, "hash-sync-other", "retro", []string{"internal/other.go"})

	last := gitOutput(t, repoDir, "rev-parse", "HEAD")
	if err := syncer.SetLastSyncedCommit(last); err != nil {
		t.Fatalf("set last commit: %v", err)
	}

	writeRepoFile(t, repoDir, "internal/retro.go", "package main\n// changed\n")
	writeRepoFile(t, repoDir, "internal/task.go", "package main\n// changed\n")
	writeRepoFile(t, repoDir, "internal/commit.go", "package main\n// changed\n")
	runGit(t, repoDir, "add", "internal/retro.go", "internal/task.go", "internal/commit.go")
	runGit(t, repoDir, "commit", "-m", "change tracked files")

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

	gotRetro, err := store.Get(retro.ID)
	if err != nil {
		t.Fatalf("get retro: %v", err)
	}
	if gotRetro.Confidence != 0.8 {
		t.Fatalf("retro confidence = %v, want 0.8", gotRetro.Confidence)
	}

	gotTask, err := store.Get(taskEntry.ID)
	if err != nil {
		t.Fatalf("get task entry: %v", err)
	}
	if gotTask.Confidence != 0.9 {
		t.Fatalf("task confidence = %v, want 0.9", gotTask.Confidence)
	}

	gotCommit, err := store.Get(commitEntry.ID)
	if err != nil {
		t.Fatalf("get commit entry: %v", err)
	}
	if gotCommit.SupersededBy != commitEntry.ID {
		t.Fatalf("commit superseded_by = %q, want self id %q", gotCommit.SupersededBy, commitEntry.ID)
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
