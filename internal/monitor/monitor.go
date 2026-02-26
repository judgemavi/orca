package monitor

// Package monitor provides runtime monitors that watch task execution
// for stuck processes and file conflicts.
//
// Consumed by: executor (monitor_coordinator.go)
// Interface: Monitor { Start(ctx) error; Stop() error }

import "context"

// Monitor defines lifecycle hooks for runtime task monitors.
type Monitor interface {
	Start(ctx context.Context) error
	Stop() error
}
