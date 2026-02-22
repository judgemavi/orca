package integrator

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// setupRepo creates a temp git repo with an initial commit and an integration branch.
func setupRepo(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}

	dir := t.TempDir()

	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}

	run("init")
	run("config", "user.email", "test@test.com")
	run("config", "user.name", "Test")

	// Initial commit with a file.
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("init\n"), 0644); err != nil {
		t.Fatalf("write file: %v", err)
	}
	run("add", "-A")
	run("commit", "-m", "init")

	// Create integration branch from HEAD.
	run("branch", "orca/integration")

	return dir
}

// createTaskBranch creates a task branch with a commit that adds/modifies a file.
func createTaskBranch(t *testing.T, dir, taskID, filename, content string) {
	t.Helper()
	branch := "orca/task-" + taskID

	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}

	run("checkout", "-b", branch, "orca/integration")
	if err := os.WriteFile(filepath.Join(dir, filename), []byte(content), 0644); err != nil {
		t.Fatalf("write file: %v", err)
	}
	run("add", "-A")
	run("commit", "-m", "task "+taskID+": add "+filename)
	run("checkout", "orca/integration")
}

func createTaskBranchWithNFiles(t *testing.T, dir, taskID string, files int) {
	t.Helper()

	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}

	run("checkout", "-b", "orca/task-"+taskID, "orca/integration")
	for idx := 1; idx <= files; idx++ {
		name := filepath.Join(dir, fmt.Sprintf("task-%s-file-%02d.txt", taskID, idx))
		if err := os.WriteFile(name, []byte("line\n"), 0644); err != nil {
			t.Fatalf("write file: %v", err)
		}
	}
	run("add", "-A")
	run("commit", "-m", "task "+taskID+": add files")
	run("checkout", "orca/integration")
}

func TestMergeSuccess(t *testing.T) {
	dir := setupRepo(t)

	createTaskBranch(t, dir, "001", "feature.go", "package main\n")

	ig := New(dir, "orca/integration", nil)
	if err := ig.Merge("001"); err != nil {
		t.Fatalf("Merge: %v", err)
	}

	// Verify integration branch has the file.
	path := filepath.Join(dir, "feature.go")
	if _, err := os.Stat(path); os.IsNotExist(err) {
		t.Error("feature.go not found on integration branch after merge")
	}
}

func TestMergeConflict(t *testing.T) {
	dir := setupRepo(t)

	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}

	// Create conflicting content on integration branch.
	run("checkout", "orca/integration")
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("integration\n"), 0644); err != nil {
		t.Fatalf("write: %v", err)
	}
	run("add", "-A")
	run("commit", "-m", "integration: add a.txt")

	// Create task branch from before the integration commit (from main).
	run("checkout", "-b", "orca/task-conflict", "HEAD~1")
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("task\n"), 0644); err != nil {
		t.Fatalf("write: %v", err)
	}
	run("add", "-A")
	run("commit", "-m", "task: add a.txt")
	run("checkout", "orca/integration")

	ig := New(dir, "orca/integration", nil)
	err := ig.Merge("conflict")
	if err == nil {
		t.Fatal("expected merge conflict error")
	}

	// Verify integration branch is clean (merge was aborted/rebased).
	cmd := exec.Command("git", "status", "--porcelain")
	cmd.Dir = dir
	out, _ := cmd.Output()
	if len(out) > 0 {
		t.Errorf("integration branch not clean after failed merge: %s", out)
	}
}

func TestValidate(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}

	dir := t.TempDir()

	t.Run("success", func(t *testing.T) {
		ig := New(dir, "main", []string{"true"})
		if err := ig.Validate(); err != nil {
			t.Errorf("Validate: %v", err)
		}
	})

	t.Run("failure", func(t *testing.T) {
		ig := New(dir, "main", []string{"false"})
		if err := ig.Validate(); err == nil {
			t.Error("expected validation error")
		}
	})
}

func TestMergeAndValidateRevert(t *testing.T) {
	dir := setupRepo(t)

	createTaskBranch(t, dir, "rv1", "revert-test.go", "package main\n")

	ig := New(dir, "orca/integration", []string{"false"})
	err := ig.MergeAndValidate("rv1")
	if err == nil {
		t.Fatal("expected MergeAndValidate to fail due to validation")
	}

	// Verify the file is NOT present (merge was reverted).
	path := filepath.Join(dir, "revert-test.go")
	if _, err := os.Stat(path); err == nil {
		t.Error("revert-test.go should not exist after validation revert")
	}
}

func TestMergeBatch(t *testing.T) {
	dir := setupRepo(t)

	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}

	// Task 1: clean merge.
	createTaskBranch(t, dir, "b1", "b1.go", "package b1\n")

	// Task 2: will conflict.
	// First add a file on integration.
	run("checkout", "orca/integration")
	if err := os.WriteFile(filepath.Join(dir, "conflict.txt"), []byte("integration\n"), 0644); err != nil {
		t.Fatalf("write: %v", err)
	}
	run("add", "-A")
	run("commit", "-m", "add conflict.txt on integration")

	// Create task branch from before that commit.
	run("checkout", "-b", "orca/task-b2", "HEAD~1")
	if err := os.WriteFile(filepath.Join(dir, "conflict.txt"), []byte("task b2\n"), 0644); err != nil {
		t.Fatalf("write: %v", err)
	}
	run("add", "-A")
	run("commit", "-m", "task b2: conflict")
	run("checkout", "orca/integration")

	// Task 3: clean merge.
	createTaskBranch(t, dir, "b3", "b3.go", "package b3\n")

	ig := New(dir, "orca/integration", nil)
	merged, failed, err := ig.MergeBatch([]string{"b1", "b2", "b3"})
	if err != nil {
		t.Fatalf("MergeBatch: %v", err)
	}
	if len(merged) != 2 {
		t.Errorf("merged = %v, want 2 items", merged)
	}
	if len(failed) != 1 {
		t.Errorf("failed = %v, want 1 item", failed)
	}
	if len(failed) == 1 && failed[0] != "b2" {
		t.Errorf("failed[0] = %q, want %q", failed[0], "b2")
	}
}

func TestMergeBatchSortsByDiffSize(t *testing.T) {
	dir := setupRepo(t)

	createTaskBranchWithNFiles(t, dir, "d1", 1)
	createTaskBranchWithNFiles(t, dir, "d10", 10)
	createTaskBranchWithNFiles(t, dir, "d5", 5)

	ig := New(dir, "orca/integration", nil)
	merged, failed, err := ig.MergeBatch([]string{"d10", "d1", "d5"})
	if err != nil {
		t.Fatalf("MergeBatch: %v", err)
	}
	if len(failed) != 0 {
		t.Fatalf("failed = %v, want none", failed)
	}
	if len(merged) != 3 {
		t.Fatalf("merged = %v, want 3 items", merged)
	}

	cmd := exec.Command("git", "log", "--first-parent", "--reverse", "--pretty=%s", "orca/integration")
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git log: %v\n%s", err, out)
	}

	var merges []string
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if strings.HasPrefix(line, "orca: merge task-") {
			merges = append(merges, line)
		}
	}

	want := []string{
		"orca: merge task-d1",
		"orca: merge task-d5",
		"orca: merge task-d10",
	}
	if len(merges) != len(want) {
		t.Fatalf("merge commits = %v, want %v", merges, want)
	}
	for i := range want {
		if merges[i] != want[i] {
			t.Fatalf("merge order = %v, want %v", merges, want)
		}
	}
}

func TestMergeBatchDiffErrorSortsFirst(t *testing.T) {
	dir := setupRepo(t)

	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}

	// Create a conflict task branch that will fail to merge.
	run("checkout", "orca/integration")
	if err := os.WriteFile(filepath.Join(dir, "shared.txt"), []byte("integration\n"), 0644); err != nil {
		t.Fatalf("write: %v", err)
	}
	run("add", "-A")
	run("commit", "-m", "integration: add shared.txt")

	run("checkout", "-b", "orca/task-conflict2", "HEAD~1")
	if err := os.WriteFile(filepath.Join(dir, "shared.txt"), []byte("task\n"), 0644); err != nil {
		t.Fatalf("write: %v", err)
	}
	run("add", "-A")
	run("commit", "-m", "task conflict2")
	run("checkout", "orca/integration")

	// Create then delete a task branch so diffLineCount returns 0 due to git diff error.
	createTaskBranch(t, dir, "missing", "missing.txt", "x\n")
	run("branch", "-D", "orca/task-missing")

	ig := New(dir, "orca/integration", nil)
	_, failed, err := ig.MergeBatch([]string{"conflict2", "missing"})
	if err != nil {
		t.Fatalf("MergeBatch: %v", err)
	}
	if len(failed) != 2 {
		t.Fatalf("failed = %v, want 2 items", failed)
	}
	if failed[0] != "missing" || failed[1] != "conflict2" {
		t.Fatalf("failed order = %v, want [missing conflict2]", failed)
	}
}

func TestAcquireFileLockLifecycle(t *testing.T) {
	dir := setupRepo(t)
	ig := New(dir, "orca/integration", nil)

	unlock, err := ig.acquireFileLock()
	if err != nil {
		t.Fatalf("acquireFileLock: %v", err)
	}

	if _, err := os.Stat(ig.lockPath); err != nil {
		t.Fatalf("lock file missing while held: %v", err)
	}

	unlock()

	if _, err := os.Stat(ig.lockPath); !os.IsNotExist(err) {
		t.Fatalf("lock file still exists after unlock: %v", err)
	}
}

func TestMergeWaitsForFileLock(t *testing.T) {
	dir := setupRepo(t)
	createTaskBranch(t, dir, "lockwait", "lockwait.go", "package lockwait\n")

	lockOwner := New(dir, "orca/integration", nil)
	unlock, err := lockOwner.acquireFileLock()
	if err != nil {
		t.Fatalf("acquireFileLock: %v", err)
	}
	defer unlock()

	ig := New(dir, "orca/integration", nil)
	done := make(chan error, 1)
	go func() {
		done <- ig.Merge("lockwait")
	}()

	select {
	case err := <-done:
		t.Fatalf("merge returned before lock release: %v", err)
	case <-time.After(200 * time.Millisecond):
		// Expected: merge is blocked on file lock.
	}

	unlock()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("merge after lock release: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("merge did not complete after lock release")
	}

	if _, err := os.Stat(ig.lockPath); !os.IsNotExist(err) {
		t.Fatalf("lock file still exists after merge: %v", err)
	}
}
