package monitor

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type stuckEvent struct {
	taskID string
	reason string
}

func TestStuckDetectorNoStuckWhenDiffChanges(t *testing.T) {
	repoDir, worktreeDir, taskID, filePath := setupRepoAndWorktree(t)
	_ = repoDir

	events := make(chan stuckEvent, 10)
	detector := NewStuckDetector(worktreeDir, 30*time.Millisecond, 100, func(taskID, reason string) {
		events <- stuckEvent{taskID: taskID, reason: reason}
	}, []string{taskID})

	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	if err := detector.Start(ctx); err != nil {
		t.Fatalf("start stuck detector: %v", err)
	}
	t.Cleanup(func() {
		if err := detector.Stop(); err != nil {
			t.Fatalf("stop stuck detector: %v", err)
		}
	})

	time.Sleep(45 * time.Millisecond)
	appendToFile(t, filePath, "\nfirst change")

	time.Sleep(45 * time.Millisecond)
	appendToFile(t, filePath, "\nsecond change")

	select {
	case got := <-events:
		t.Fatalf("unexpected stuck event: %+v", got)
	case <-time.After(150 * time.Millisecond):
	}
}

func TestStuckDetectorFiresAfterNoProgress(t *testing.T) {
	_, worktreeDir, taskID, _ := setupRepoAndWorktree(t)

	events := make(chan stuckEvent, 10)
	detector := NewStuckDetector(worktreeDir, 20*time.Millisecond, 2, func(taskID, reason string) {
		events <- stuckEvent{taskID: taskID, reason: reason}
	}, []string{taskID})

	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	if err := detector.Start(ctx); err != nil {
		t.Fatalf("start stuck detector: %v", err)
	}
	t.Cleanup(func() {
		if err := detector.Stop(); err != nil {
			t.Fatalf("stop stuck detector: %v", err)
		}
	})

	select {
	case got := <-events:
		if got.taskID != taskID {
			t.Fatalf("unexpected task id: got %s want %s", got.taskID, taskID)
		}
		if !strings.Contains(got.reason, "no progress") || !strings.Contains(got.reason, "2 checks") {
			t.Fatalf("unexpected reason: %q", got.reason)
		}
	case <-time.After(800 * time.Millisecond):
		t.Fatal("timed out waiting for no-progress stuck detection")
	}
}

func TestStuckDetectorDetectsEditRevertCycle(t *testing.T) {
	repoDir, worktreeDir, taskID, filePath := setupRepoAndWorktree(t)

	events := make(chan stuckEvent, 10)
	detector := NewStuckDetector(worktreeDir, 25*time.Millisecond, 10, func(taskID, reason string) {
		events <- stuckEvent{taskID: taskID, reason: reason}
	}, []string{taskID})

	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	if err := detector.Start(ctx); err != nil {
		t.Fatalf("start stuck detector: %v", err)
	}
	t.Cleanup(func() {
		if err := detector.Stop(); err != nil {
			t.Fatalf("stop stuck detector: %v", err)
		}
	})

	time.Sleep(40 * time.Millisecond)
	appendToFile(t, filePath, "\nchange then revert")
	time.Sleep(40 * time.Millisecond)
	runGit(t, filepath.Join(worktreeDir, "task-"+taskID), "checkout", "--", "README.md")

	select {
	case got := <-events:
		if got.taskID != taskID {
			t.Fatalf("unexpected task id: got %s want %s", got.taskID, taskID)
		}
		if got.reason != "edit-revert cycle detected" {
			t.Fatalf("unexpected reason: %q", got.reason)
		}
	case <-time.After(800 * time.Millisecond):
		t.Fatal("timed out waiting for edit-revert cycle detection")
	}

	_ = repoDir
}

func setupRepoAndWorktree(t *testing.T) (repoDir, worktreeDir, taskID, filePath string) {
	t.Helper()

	root := t.TempDir()
	repoDir = filepath.Join(root, "repo")
	worktreeDir = filepath.Join(root, "worktrees")
	taskID = "123"

	if err := os.MkdirAll(repoDir, 0o755); err != nil {
		t.Fatalf("mkdir repo dir: %v", err)
	}
	if err := os.MkdirAll(worktreeDir, 0o755); err != nil {
		t.Fatalf("mkdir worktree dir: %v", err)
	}

	runGit(t, repoDir, "init")
	runGit(t, repoDir, "config", "user.name", "Test User")
	runGit(t, repoDir, "config", "user.email", "test@example.com")

	filePath = filepath.Join(repoDir, "README.md")
	if err := os.WriteFile(filePath, []byte("hello\n"), 0o644); err != nil {
		t.Fatalf("write initial file: %v", err)
	}

	runGit(t, repoDir, "add", ".")
	runGit(t, repoDir, "commit", "-m", "initial commit")

	wtPath := filepath.Join(worktreeDir, "task-"+taskID)
	runGit(t, repoDir, "worktree", "add", wtPath, "-b", "orca/task-"+taskID, "HEAD")

	return repoDir, worktreeDir, taskID, filepath.Join(wtPath, "README.md")
}

func appendToFile(t *testing.T, path string, extra string) {
	t.Helper()

	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatalf("open file for append: %v", err)
	}
	defer f.Close()

	if _, err := f.WriteString(extra); err != nil {
		t.Fatalf("append to file: %v", err)
	}
}

func runGit(t *testing.T, dir string, args ...string) {
	t.Helper()

	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s failed: %v\n%s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
}
