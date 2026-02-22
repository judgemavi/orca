package monitor

import (
	"context"
	"sync"
	"testing"
	"time"
)

type exceededEvent struct {
	taskID string
	spent  float64
	limit  float64
}

func TestBudgetEnforcerTaskBudgetFiresOnce(t *testing.T) {
	var mu sync.Mutex
	calls := map[string]int{}

	costFn := func(taskID string) float64 {
		mu.Lock()
		defer mu.Unlock()
		calls[taskID]++
		if calls[taskID] >= 3 {
			return 1.0
		}
		return 0.4
	}

	events := make(chan exceededEvent, 8)
	enforcer := NewBudgetEnforcer(
		10*time.Millisecond,
		1.0,
		0,
		costFn,
		func(taskID string, spent float64, limit float64) {
			events <- exceededEvent{taskID: taskID, spent: spent, limit: limit}
		},
	)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	enforcer.Start(ctx, []string{"task-1"})
	defer enforcer.Stop()

	var first exceededEvent
	select {
	case first = <-events:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("expected task budget callback")
	}

	if first.taskID != "task-1" || first.limit != 1.0 {
		t.Fatalf("unexpected callback: %+v", first)
	}

	select {
	case extra := <-events:
		t.Fatalf("unexpected extra callback: %+v", extra)
	case <-time.After(120 * time.Millisecond):
	}
}

func TestBudgetEnforcerDisabledBudgetsNeverFire(t *testing.T) {
	costFn := func(taskID string) float64 {
		return 10.0
	}

	events := make(chan exceededEvent, 8)
	enforcer := NewBudgetEnforcer(
		10*time.Millisecond,
		0,
		0,
		costFn,
		func(taskID string, spent float64, limit float64) {
			events <- exceededEvent{taskID: taskID, spent: spent, limit: limit}
		},
	)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	enforcer.Start(ctx, []string{"task-1", "task-2"})
	defer enforcer.Stop()

	select {
	case ev := <-events:
		t.Fatalf("unexpected callback with disabled budgets: %+v", ev)
	case <-time.After(120 * time.Millisecond):
	}
}

func TestBudgetEnforcerSprintBudgetSumsTasks(t *testing.T) {
	costFn := func(taskID string) float64 {
		switch taskID {
		case "task-1":
			return 0.6
		case "task-2":
			return 0.5
		default:
			return 0
		}
	}

	events := make(chan exceededEvent, 8)
	enforcer := NewBudgetEnforcer(
		10*time.Millisecond,
		0,
		1.0,
		costFn,
		func(taskID string, spent float64, limit float64) {
			events <- exceededEvent{taskID: taskID, spent: spent, limit: limit}
		},
	)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	enforcer.Start(ctx, []string{"task-1", "task-2"})
	defer enforcer.Stop()

	select {
	case ev := <-events:
		if ev.taskID != "sprint" {
			t.Fatalf("expected sprint callback, got %+v", ev)
		}
		if ev.limit != 1.0 {
			t.Fatalf("sprint limit = %.2f, want 1.0", ev.limit)
		}
		if ev.spent < 1.1 {
			t.Fatalf("sprint spent = %.2f, want at least 1.1", ev.spent)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("expected sprint budget callback")
	}

	select {
	case extra := <-events:
		t.Fatalf("unexpected extra sprint callback: %+v", extra)
	case <-time.After(120 * time.Millisecond):
	}
}
