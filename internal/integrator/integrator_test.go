package integrator

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
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
	run("branch", "pod/integration")

	return dir
}

// createTaskBranch creates a task branch with a commit that adds/modifies a file.
func createTaskBranch(t *testing.T, dir, taskID, filename, content string) {
	t.Helper()
	branch := "pod/task-" + taskID

	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}

	run("checkout", "-b", branch, "pod/integration")
	if err := os.WriteFile(filepath.Join(dir, filename), []byte(content), 0644); err != nil {
		t.Fatalf("write file: %v", err)
	}
	run("add", "-A")
	run("commit", "-m", "task "+taskID+": add "+filename)
	run("checkout", "pod/integration")
}

func TestMergeSuccess(t *testing.T) {
	dir := setupRepo(t)

	createTaskBranch(t, dir, "001", "feature.go", "package main\n")

	ig := New(dir, "pod/integration", nil)
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
	run("checkout", "pod/integration")
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("integration\n"), 0644); err != nil {
		t.Fatalf("write: %v", err)
	}
	run("add", "-A")
	run("commit", "-m", "integration: add a.txt")

	// Create task branch from before the integration commit (from main).
	run("checkout", "-b", "pod/task-conflict", "HEAD~1")
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("task\n"), 0644); err != nil {
		t.Fatalf("write: %v", err)
	}
	run("add", "-A")
	run("commit", "-m", "task: add a.txt")
	run("checkout", "pod/integration")

	ig := New(dir, "pod/integration", nil)
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

	ig := New(dir, "pod/integration", []string{"false"})
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
	run("checkout", "pod/integration")
	if err := os.WriteFile(filepath.Join(dir, "conflict.txt"), []byte("integration\n"), 0644); err != nil {
		t.Fatalf("write: %v", err)
	}
	run("add", "-A")
	run("commit", "-m", "add conflict.txt on integration")

	// Create task branch from before that commit.
	run("checkout", "-b", "pod/task-b2", "HEAD~1")
	if err := os.WriteFile(filepath.Join(dir, "conflict.txt"), []byte("task b2\n"), 0644); err != nil {
		t.Fatalf("write: %v", err)
	}
	run("add", "-A")
	run("commit", "-m", "task b2: conflict")
	run("checkout", "pod/integration")

	// Task 3: clean merge.
	createTaskBranch(t, dir, "b3", "b3.go", "package b3\n")

	ig := New(dir, "pod/integration", nil)
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
