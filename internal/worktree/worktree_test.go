package worktree

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestCleanupStaleRemovesOnlyOldWorktrees(t *testing.T) {
	m, worktreeDir := newTestManagerWithRepo(t)

	oldID1 := "old1"
	oldID2 := "old2"
	newID := "new1"

	oldPath1, _, err := m.Create(oldID1, "main")
	if err != nil {
		t.Fatalf("Create(%s) error = %v", oldID1, err)
	}
	oldPath2, _, err := m.Create(oldID2, "main")
	if err != nil {
		t.Fatalf("Create(%s) error = %v", oldID2, err)
	}
	newPath, _, err := m.Create(newID, "main")
	if err != nil {
		t.Fatalf("Create(%s) error = %v", newID, err)
	}

	oldTime := time.Now().Add(-2 * time.Hour)
	if err := os.Chtimes(oldPath1, oldTime, oldTime); err != nil {
		t.Fatalf("Chtimes(%s) error = %v", oldPath1, err)
	}
	if err := os.Chtimes(oldPath2, oldTime, oldTime); err != nil {
		t.Fatalf("Chtimes(%s) error = %v", oldPath2, err)
	}

	removed, errs := m.CleanupStale(time.Hour)
	if len(errs) != 0 {
		t.Fatalf("CleanupStale() errs = %v, want none", errs)
	}
	if len(removed) != 2 {
		t.Fatalf("CleanupStale() removed = %v, want 2 entries", removed)
	}

	if _, err := os.Stat(filepath.Join(worktreeDir, "task-"+oldID1)); !os.IsNotExist(err) {
		t.Fatalf("old worktree %s should be removed; stat err = %v", oldID1, err)
	}
	if _, err := os.Stat(filepath.Join(worktreeDir, "task-"+oldID2)); !os.IsNotExist(err) {
		t.Fatalf("old worktree %s should be removed; stat err = %v", oldID2, err)
	}
	if _, err := os.Stat(newPath); err != nil {
		t.Fatalf("new worktree should remain; stat err = %v", err)
	}
}

func TestDiskUsageReturnsNonZero(t *testing.T) {
	tempDir := t.TempDir()
	worktreeDir := filepath.Join(tempDir, "worktrees")
	if err := os.MkdirAll(filepath.Join(worktreeDir, "task-1"), 0o755); err != nil {
		t.Fatalf("MkdirAll() error = %v", err)
	}
	if err := os.WriteFile(filepath.Join(worktreeDir, "task-1", "data.txt"), []byte("123456"), 0o644); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	m := NewManager(tempDir, worktreeDir)
	total, err := m.DiskUsage()
	if err != nil {
		t.Fatalf("DiskUsage() error = %v", err)
	}
	if total <= 0 {
		t.Fatalf("DiskUsage() = %d, want > 0", total)
	}
}

func TestListWithAgeReturnsTaskIDsAndAges(t *testing.T) {
	tempDir := t.TempDir()
	worktreeDir := filepath.Join(tempDir, "worktrees")
	if err := os.MkdirAll(worktreeDir, 0o755); err != nil {
		t.Fatalf("MkdirAll(worktreeDir) error = %v", err)
	}

	taskAPath := filepath.Join(worktreeDir, "task-a")
	taskBPath := filepath.Join(worktreeDir, "task-b")
	if err := os.MkdirAll(taskAPath, 0o755); err != nil {
		t.Fatalf("MkdirAll(task-a) error = %v", err)
	}
	if err := os.MkdirAll(taskBPath, 0o755); err != nil {
		t.Fatalf("MkdirAll(task-b) error = %v", err)
	}

	old := time.Now().Add(-2 * time.Second)
	if err := os.Chtimes(taskAPath, old, old); err != nil {
		t.Fatalf("Chtimes(task-a) error = %v", err)
	}
	if err := os.Chtimes(taskBPath, old, old); err != nil {
		t.Fatalf("Chtimes(task-b) error = %v", err)
	}

	m := NewManager(tempDir, worktreeDir)
	got, err := m.ListWithAge()
	if err != nil {
		t.Fatalf("ListWithAge() error = %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("ListWithAge() len = %d, want 2", len(got))
	}

	seen := map[string]bool{}
	for _, w := range got {
		seen[w.TaskID] = true
		if w.Age <= 0 {
			t.Fatalf("Task %s age = %v, want > 0", w.TaskID, w.Age)
		}
	}
	if !seen["a"] || !seen["b"] {
		t.Fatalf("ListWithAge() task IDs = %v, want a and b", got)
	}
}

func newTestManagerWithRepo(t *testing.T) (*Manager, string) {
	t.Helper()

	repoDir := t.TempDir()
	runGit(t, repoDir, "init")
	runGit(t, repoDir, "config", "user.email", "test@example.com")
	runGit(t, repoDir, "config", "user.name", "Test User")

	readme := filepath.Join(repoDir, "README.md")
	if err := os.WriteFile(readme, []byte("hello"), 0o644); err != nil {
		t.Fatalf("WriteFile(README.md) error = %v", err)
	}
	runGit(t, repoDir, "add", "README.md")
	runGit(t, repoDir, "commit", "-m", "init")
	runGit(t, repoDir, "branch", "-M", "main")

	worktreeDir := filepath.Join(repoDir, ".orca", "worktrees")
	return NewManager(repoDir, worktreeDir), worktreeDir
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
