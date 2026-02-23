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
	taskIDs     []string
	interval    time.Duration
	maxCycles   int // consecutive zero-progress checks before firing (default 3)
	onStuck     func(taskID string, reason string)

	mu         sync.Mutex
	lastHash   map[string]string
	history    map[string][]string
	noProgress map[string]int

	cancel  context.CancelFunc
	done    chan struct{}
	running bool
}

// NewStuckDetector creates a new detector.
func NewStuckDetector(worktreeDir string, interval time.Duration, maxCycles int, onStuck func(string, string), taskIDs []string) *StuckDetector {
	if interval <= 0 {
		interval = 30 * time.Second
	}
	if maxCycles <= 0 {
		maxCycles = 3
	}
	return &StuckDetector{
		worktreeDir: worktreeDir,
		taskIDs:     append([]string(nil), taskIDs...),
		interval:    interval,
		maxCycles:   maxCycles,
		onStuck:     onStuck,
		lastHash:    make(map[string]string),
		history:     make(map[string][]string),
		noProgress:  make(map[string]int),
	}
}

// Start runs polling until ctx is cancelled or Stop is called.
func (d *StuckDetector) Start(ctx context.Context) error {
	d.mu.Lock()
	if d.running {
		d.mu.Unlock()
		return nil
	}

	runCtx, cancel := context.WithCancel(ctx)
	d.cancel = cancel
	d.done = make(chan struct{})
	d.running = true
	taskIDsCopy := append([]string(nil), d.taskIDs...)
	interval := d.interval
	done := d.done
	d.mu.Unlock()

	go func() {
		defer close(done)

		d.poll(taskIDsCopy)

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
				d.poll(taskIDsCopy)
			}
		}
	}()

	return nil
}

// Stop stops polling and waits for in-flight polls to finish.
func (d *StuckDetector) Stop() error {
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

var _ Monitor = (*StuckDetector)(nil)

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
