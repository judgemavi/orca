package monitor

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"
)

type conflictEvent struct {
	taskIDs []string
	files   []string
}

func TestConflictDetectorNoConflictForDifferentFiles(t *testing.T) {
	_, worktreeDir, paths := setupConflictWorktrees(t, []string{"1", "2"})
	writeWorktreeFile(t, filepath.Join(paths["1"], "one.txt"), "task1 update\n")
	writeWorktreeFile(t, filepath.Join(paths["2"], "two.txt"), "task2 update\n")

	events := make(chan conflictEvent, 4)
	detector := NewConflictDetector(worktreeDir, 20*time.Millisecond, func(taskIDs []string, files []string) {
		events <- conflictEvent{taskIDs: taskIDs, files: files}
	})

	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	detector.Start(ctx, []string{"1", "2"})
	t.Cleanup(detector.Stop)

	select {
	case ev := <-events:
		t.Fatalf("unexpected conflict event: %+v", ev)
	case <-time.After(180 * time.Millisecond):
	}
}

func TestConflictDetectorFiresForSameFile(t *testing.T) {
	_, worktreeDir, paths := setupConflictWorktrees(t, []string{"1", "2"})
	writeWorktreeFile(t, filepath.Join(paths["1"], "shared.txt"), "task1 update\n")
	writeWorktreeFile(t, filepath.Join(paths["2"], "shared.txt"), "task2 update\n")

	events := make(chan conflictEvent, 4)
	detector := NewConflictDetector(worktreeDir, 20*time.Millisecond, func(taskIDs []string, files []string) {
		events <- conflictEvent{taskIDs: taskIDs, files: files}
	})

	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	detector.Start(ctx, []string{"1", "2"})
	t.Cleanup(detector.Stop)

	select {
	case ev := <-events:
		if !reflect.DeepEqual(ev.taskIDs, []string{"1", "2"}) {
			t.Fatalf("taskIDs mismatch: got %v want [1 2]", ev.taskIDs)
		}
		if !reflect.DeepEqual(ev.files, []string{"shared.txt"}) {
			t.Fatalf("files mismatch: got %v want [shared.txt]", ev.files)
		}
	case <-time.After(700 * time.Millisecond):
		t.Fatal("timed out waiting for conflict event")
	}
}

func TestConflictDetectorDeduplicatesSameConflict(t *testing.T) {
	_, worktreeDir, paths := setupConflictWorktrees(t, []string{"1", "2"})
	writeWorktreeFile(t, filepath.Join(paths["1"], "shared.txt"), "task1 update\n")
	writeWorktreeFile(t, filepath.Join(paths["2"], "shared.txt"), "task2 update\n")

	events := make(chan conflictEvent, 8)
	detector := NewConflictDetector(worktreeDir, 15*time.Millisecond, func(taskIDs []string, files []string) {
		events <- conflictEvent{taskIDs: taskIDs, files: files}
	})

	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	detector.Start(ctx, []string{"1", "2"})
	t.Cleanup(detector.Stop)

	select {
	case <-events:
	case <-time.After(700 * time.Millisecond):
		t.Fatal("timed out waiting for initial conflict")
	}

	select {
	case ev := <-events:
		t.Fatalf("unexpected duplicate conflict event: %+v", ev)
	case <-time.After(180 * time.Millisecond):
	}
}

func TestConflictDetectorSkipsRemovedWorktreeAndContinues(t *testing.T) {
	_, worktreeDir, paths := setupConflictWorktrees(t, []string{"1", "2", "3"})
	writeWorktreeFile(t, filepath.Join(paths["1"], "shared.txt"), "task1 update\n")
	writeWorktreeFile(t, filepath.Join(paths["2"], "shared.txt"), "task2 update\n")

	events := make(chan conflictEvent, 8)
	detector := NewConflictDetector(worktreeDir, 20*time.Millisecond, func(taskIDs []string, files []string) {
		events <- conflictEvent{taskIDs: taskIDs, files: files}
	})

	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	detector.Start(ctx, []string{"1", "2", "3"})
	t.Cleanup(detector.Stop)

	first := waitConflictEvent(t, events)
	if !reflect.DeepEqual(first.taskIDs, []string{"1", "2"}) || !reflect.DeepEqual(first.files, []string{"shared.txt"}) {
		t.Fatalf("unexpected first conflict: %+v", first)
	}

	if err := os.RemoveAll(paths["2"]); err != nil {
		t.Fatalf("remove worktree 2: %v", err)
	}

	writeWorktreeFile(t, filepath.Join(paths["3"], "shared.txt"), "task3 update\n")

	second := waitConflictEvent(t, events)
	if !reflect.DeepEqual(second.taskIDs, []string{"1", "3"}) || !reflect.DeepEqual(second.files, []string{"shared.txt"}) {
		t.Fatalf("unexpected second conflict: %+v", second)
	}
}

func waitConflictEvent(t *testing.T, events <-chan conflictEvent) conflictEvent {
	t.Helper()

	select {
	case ev := <-events:
		return ev
	case <-time.After(900 * time.Millisecond):
		t.Fatal("timed out waiting for conflict event")
		return conflictEvent{}
	}
}

func setupConflictWorktrees(t *testing.T, taskIDs []string) (repoDir, worktreeDir string, worktrees map[string]string) {
	t.Helper()

	root := t.TempDir()
	repoDir = filepath.Join(root, "repo")
	worktreeDir = filepath.Join(root, "worktrees")
	worktrees = make(map[string]string, len(taskIDs))

	if err := os.MkdirAll(repoDir, 0o755); err != nil {
		t.Fatalf("mkdir repo dir: %v", err)
	}
	if err := os.MkdirAll(worktreeDir, 0o755); err != nil {
		t.Fatalf("mkdir worktree dir: %v", err)
	}

	runConflictGit(t, repoDir, "init")
	runConflictGit(t, repoDir, "config", "user.name", "Test User")
	runConflictGit(t, repoDir, "config", "user.email", "test@example.com")

	writeRepoFile(t, filepath.Join(repoDir, "shared.txt"), "base\n")
	writeRepoFile(t, filepath.Join(repoDir, "one.txt"), "base\n")
	writeRepoFile(t, filepath.Join(repoDir, "two.txt"), "base\n")

	runConflictGit(t, repoDir, "add", ".")
	runConflictGit(t, repoDir, "commit", "-m", "initial")

	sortedIDs := append([]string(nil), taskIDs...)
	sort.Strings(sortedIDs)
	for _, taskID := range sortedIDs {
		wtPath := filepath.Join(worktreeDir, "task-"+taskID)
		runConflictGit(t, repoDir, "worktree", "add", wtPath, "-b", "pod/task-"+taskID, "HEAD")
		worktrees[taskID] = wtPath
	}

	return repoDir, worktreeDir, worktrees
}

func writeRepoFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write file %s: %v", path, err)
	}
}

func writeWorktreeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write worktree file %s: %v", path, err)
	}
}

func runConflictGit(t *testing.T, dir string, args ...string) {
	t.Helper()

	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s failed: %v\n%s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
}
