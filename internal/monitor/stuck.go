package monitor

import (
	"context"
	"crypto/sha256"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/jasjeetmavi/orca/internal/worktree"
)

// StuckDetector polls task worktrees to detect no-progress loops and edit-revert cycles.
type StuckDetector struct {
	worktreeDir string
	interval    time.Duration
	maxCycles   int // consecutive zero-progress checks before firing (default 3)
	onStuck     func(taskID string, reason string)

	mu         sync.Mutex
	lastHash   map[string]string
	history    map[string][]string
	noProgress map[string]int

	stopOnce sync.Once
	stopCh   chan struct{}
	wg       sync.WaitGroup
}

// NewStuckDetector creates a new detector.
func NewStuckDetector(worktreeDir string, interval time.Duration, maxCycles int, onStuck func(string, string)) *StuckDetector {
	if interval <= 0 {
		interval = 30 * time.Second
	}
	if maxCycles <= 0 {
		maxCycles = 3
	}
	return &StuckDetector{
		worktreeDir: worktreeDir,
		interval:    interval,
		maxCycles:   maxCycles,
		onStuck:     onStuck,
		lastHash:    make(map[string]string),
		history:     make(map[string][]string),
		noProgress:  make(map[string]int),
		stopCh:      make(chan struct{}),
	}
}

// Start runs polling until ctx is cancelled or Stop is called.
func (d *StuckDetector) Start(ctx context.Context, taskIDs []string) {
	taskIDsCopy := append([]string(nil), taskIDs...)
	d.wg.Add(1)
	go func() {
		defer d.wg.Done()

		d.wg.Add(1)
		go func() {
			defer d.wg.Done()
			d.poll(taskIDsCopy)
		}()

		ticker := time.NewTicker(d.interval)
		defer ticker.Stop()

		for {
			select {
			case <-ctx.Done():
				return
			case <-d.stopCh:
				return
			case <-ticker.C:
				d.wg.Add(1)
				go func(ids []string) {
					defer d.wg.Done()
					d.poll(ids)
				}(taskIDsCopy)
			}
		}
	}()
}

// Stop stops polling and waits for in-flight polls to finish.
func (d *StuckDetector) Stop() {
	d.stopOnce.Do(func() {
		close(d.stopCh)
	})
	d.wg.Wait()
}

func (d *StuckDetector) poll(taskIDs []string) {
	for _, taskID := range taskIDs {
		worktreePath := worktree.ResolveTaskDir(d.worktreeDir, taskID)

		if _, err := os.Stat(worktreePath); err != nil {
			continue
		}

		hash, err := diffHash(worktreePath)
		if err != nil {
			continue
		}

		var callbacks []string

		d.mu.Lock()
		last, hasLast := d.lastHash[taskID]
		if !hasLast {
			d.lastHash[taskID] = hash
			d.history[taskID] = append(d.history[taskID], hash)
			d.noProgress[taskID] = 0
			d.mu.Unlock()
			continue
		}

		if hash == last {
			d.noProgress[taskID]++
			if d.noProgress[taskID] == d.maxCycles {
				callbacks = append(callbacks, fmt.Sprintf("no progress: diff unchanged for %d checks", d.maxCycles))
			}
		} else {
			d.noProgress[taskID] = 0
			if seenBefore(d.history[taskID], hash) {
				callbacks = append(callbacks, "edit-revert cycle detected")
			}
		}

		d.lastHash[taskID] = hash
		d.history[taskID] = append(d.history[taskID], hash)
		d.mu.Unlock()

		if d.onStuck != nil {
			for _, reason := range callbacks {
				d.onStuck(taskID, reason)
			}
		}
	}
}

func diffHash(worktreePath string) (string, error) {
	cmd := exec.Command("git", "diff", "--stat", "HEAD")
	cmd.Dir = worktreePath

	out, err := cmd.Output()
	if err != nil {
		return "", err
	}

	sum := sha256.Sum256(out)
	return fmt.Sprintf("%x", sum), nil
}

func seenBefore(history []string, hash string) bool {
	for _, h := range history {
		if strings.EqualFold(h, hash) {
			return true
		}
	}
	return false
}
