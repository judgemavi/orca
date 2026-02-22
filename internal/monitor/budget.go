package monitor

import (
	"context"
	"sync"
	"time"
)

// BudgetEnforcer periodically checks task and sprint spend against configured limits.
type BudgetEnforcer struct {
	interval     time.Duration
	taskBudget   float64 // max $ per task (0 = disabled)
	sprintBudget float64 // max $ per sprint (0 = disabled)
	costFn       func(taskID string) float64 // returns current cost for a task
	onExceeded   func(taskID string, spent float64, limit float64)

	mu      sync.Mutex
	fired   map[string]bool
	cancel  context.CancelFunc
	done    chan struct{}
	running bool
}

// NewBudgetEnforcer creates a new enforcer with sane defaults.
func NewBudgetEnforcer(interval time.Duration, taskBudget, sprintBudget float64,
	costFn func(string) float64,
	onExceeded func(string, float64, float64),
) *BudgetEnforcer {
	if interval <= 0 {
		interval = 30 * time.Second
	}

	return &BudgetEnforcer{
		interval:     interval,
		taskBudget:   taskBudget,
		sprintBudget: sprintBudget,
		costFn:       costFn,
		onExceeded:   onExceeded,
		fired:        make(map[string]bool),
	}
}

// Start begins periodic budget checks and runs until context cancellation or Stop.
func (b *BudgetEnforcer) Start(ctx context.Context, taskIDs []string) {
	if b.costFn == nil || b.onExceeded == nil {
		return
	}

	b.mu.Lock()
	if b.running {
		b.mu.Unlock()
		return
	}

	runCtx, cancel := context.WithCancel(ctx)
	b.cancel = cancel
	b.done = make(chan struct{})
	b.fired = make(map[string]bool)
	b.running = true

	ids := append([]string(nil), taskIDs...)
	interval := b.interval
	done := b.done
	b.mu.Unlock()

	go func() {
		defer close(done)

		b.check(ids)

		ticker := time.NewTicker(interval)
		defer ticker.Stop()

		for {
			select {
			case <-runCtx.Done():
				return
			case <-ticker.C:
				b.check(ids)
			}
		}
	}()
}

// Stop terminates the polling goroutine.
func (b *BudgetEnforcer) Stop() {
	b.mu.Lock()
	if !b.running {
		b.mu.Unlock()
		return
	}

	cancel := b.cancel
	done := b.done
	b.cancel = nil
	b.done = nil
	b.running = false
	b.mu.Unlock()

	if cancel != nil {
		cancel()
	}
	if done != nil {
		<-done
	}
}

func (b *BudgetEnforcer) check(taskIDs []string) {
	total := 0.0
	type event struct {
		taskID string
		spent  float64
		limit  float64
	}

	events := make([]event, 0)
	for _, taskID := range taskIDs {
		spent := b.costFn(taskID)
		total += spent

		if b.taskBudget > 0 && spent >= b.taskBudget && b.markFired(taskID) {
			events = append(events, event{taskID: taskID, spent: spent, limit: b.taskBudget})
		}
	}

	if b.sprintBudget > 0 && total >= b.sprintBudget && b.markFired("sprint") {
		events = append(events, event{taskID: "sprint", spent: total, limit: b.sprintBudget})
	}

	for _, ev := range events {
		b.onExceeded(ev.taskID, ev.spent, ev.limit)
	}
}

func (b *BudgetEnforcer) markFired(key string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()

	if b.fired[key] {
		return false
	}
	b.fired[key] = true
	return true
}
