package monitor

// conflict.go detects overlapping file edits across concurrent task worktrees.

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/jasjeetmavi/orca/internal/worktree"
)

// ConflictDetector polls active worktrees and reports overlapping file edits.
type ConflictDetector struct {
	worktreeDir string
	taskIDs     []string
	interval    time.Duration
	onConflict  func(taskIDs []string, files []string)
	fired       map[string]bool // dedup key: sorted taskIDs + files

	mu      sync.Mutex
	cancel  context.CancelFunc
	done    chan struct{}
	running bool
}

type conflictGroup struct {
	taskIDs []string
	files   []string
}

var _ Monitor = (*ConflictDetector)(nil)

// NewConflictDetector creates a conflict detector with sane defaults.
func NewConflictDetector(worktreeDir string, interval time.Duration,
	onConflict func([]string, []string),
	taskIDs []string,
) *ConflictDetector {
	if interval <= 0 {
		interval = 15 * time.Second
	}

	return &ConflictDetector{
		worktreeDir: worktreeDir,
		taskIDs:     append([]string(nil), taskIDs...),
		interval:    interval,
		onConflict:  onConflict,
		fired:       make(map[string]bool),
	}
}

// Start begins periodic conflict checks until context cancellation or Stop.
func (d *ConflictDetector) Start(ctx context.Context) error {
	d.mu.Lock()
	if d.running {
		d.mu.Unlock()
		return nil
	}

	runCtx, cancel := context.WithCancel(ctx)
	d.cancel = cancel
	d.done = make(chan struct{})
	d.running = true

	ids := append([]string(nil), d.taskIDs...)
	interval := d.interval
	done := d.done
	d.mu.Unlock()

	go func() {
		defer close(done)

		d.check(ids)

		ticker := time.NewTicker(interval)
		defer ticker.Stop()

		for {
			select {
			case <-runCtx.Done():
				d.mu.Lock()
				d.running = false
				d.cancel = nil
				d.done = nil
				d.mu.Unlock()
				return
			case <-ticker.C:
				d.check(ids)
			}
		}
	}()

	return nil
}

// Stop halts the monitoring goroutine.
func (d *ConflictDetector) Stop() error {
	d.mu.Lock()
	if !d.running {
		d.mu.Unlock()
		return nil
	}

	cancel := d.cancel
	done := d.done
	d.cancel = nil
	d.done = nil
	d.running = false
	d.mu.Unlock()

	if cancel != nil {
		cancel()
	}
	if done != nil {
		<-done
	}

	return nil
}

func (d *ConflictDetector) check(taskIDs []string) {
	filesToTasks := make(map[string][]string)

	for _, taskID := range taskIDs {
		worktreePath := worktree.ResolveTaskDir(d.worktreeDir, taskID)
		if _, err := os.Stat(worktreePath); err != nil {
			continue
		}

		files, err := diffNames(worktreePath)
		if err != nil {
			continue
		}

		for _, file := range files {
			tasks := filesToTasks[file]
			if !containsTask(tasks, taskID) {
				filesToTasks[file] = append(tasks, taskID)
			}
		}
	}

	grouped := make(map[string]*conflictGroup)
	for file, tasks := range filesToTasks {
		if len(tasks) < 2 {
			continue
		}

		sortedTasks := append([]string(nil), tasks...)
		sort.Strings(sortedTasks)
		groupKey := strings.Join(sortedTasks, "\x00")

		group := grouped[groupKey]
		if group == nil {
			group = &conflictGroup{taskIDs: sortedTasks}
			grouped[groupKey] = group
		}
		group.files = append(group.files, file)
	}

	for _, group := range grouped {
		sort.Strings(group.files)
		dedupKey := conflictKey(group.taskIDs, group.files)
		if !d.markFired(dedupKey) {
			continue
		}

		if d.onConflict != nil {
			taskIDsCopy := append([]string(nil), group.taskIDs...)
			filesCopy := append([]string(nil), group.files...)
			d.onConflict(taskIDsCopy, filesCopy)
		}
	}
}

func (d *ConflictDetector) markFired(key string) bool {
	d.mu.Lock()
	defer d.mu.Unlock()

	if d.fired[key] {
		return false
	}
	d.fired[key] = true
	return true
}

func diffNames(worktreePath string) ([]string, error) {
	cmd := exec.Command("git", "diff", "--name-only", "HEAD")
	cmd.Dir = worktreePath

	out, err := cmd.Output()
	if err != nil {
		return nil, err
	}

	trimmed := strings.TrimSpace(string(out))
	if trimmed == "" {
		return nil, nil
	}

	lines := strings.Split(trimmed, "\n")
	files := make([]string, 0, len(lines))
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		files = append(files, line)
	}
	return files, nil
}

func conflictKey(taskIDs, files []string) string {
	return fmt.Sprintf("tasks:%s|files:%s", strings.Join(taskIDs, ","), strings.Join(files, ","))
}

func containsTask(taskIDs []string, taskID string) bool {
	for _, id := range taskIDs {
		if id == taskID {
			return true
		}
	}
	return false
}
