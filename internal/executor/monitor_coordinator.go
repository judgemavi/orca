package executor

// monitor_coordinator.go wires up runtime monitors (stuck, conflict)
// and provides the callback glue between monitor alerts and executor actions.
//
// Called by: RunBatch
// Key flow: startMonitors → [stuck|conflict].Start → callbacks → killProcess

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/jasjeetmavi/orca/internal/monitor"
)

func (e *Executor) startMonitors(ctx context.Context, taskIDs []string) context.CancelFunc {
	monCtx, monCancel := context.WithCancel(ctx)
	e.monitors = nil

	stuckCheckInterval := 30 * time.Second
	if raw := strings.TrimSpace(e.config.Monitor.StuckCheckInterval); raw != "" {
		if parsed, err := time.ParseDuration(raw); err != nil {
			slog.Warn("monitor invalid stuck_check_interval, using default", "raw", raw, "default", "30s", "err", err)
		} else {
			stuckCheckInterval = parsed
		}
	}

	maxStuckCycles := 3
	if e.config.Monitor.MaxStuckCycles > 0 {
		maxStuckCycles = e.config.Monitor.MaxStuckCycles
	}

	conflictInterval := 15 * time.Second
	if raw := strings.TrimSpace(e.config.Monitor.ConflictInterval); raw != "" {
		if parsed, err := time.ParseDuration(raw); err != nil {
			slog.Warn("monitor invalid conflict_check_interval, using default", "raw", raw, "default", "15s", "err", err)
		} else {
			conflictInterval = parsed
		}
	}

	stuck := monitor.NewStuckDetector(
		e.config.Project.WorktreeDir,
		stuckCheckInterval,
		maxStuckCycles,
		e.checkStuck,
		taskIDs,
	)
	e.monitors = append(e.monitors, stuck)

	conflict := monitor.NewConflictDetector(
		e.config.Project.WorktreeDir,
		conflictInterval,
		e.checkConflicts,
		taskIDs,
	)
	e.monitors = append(e.monitors, conflict)

	for _, m := range e.monitors {
		if err := m.Start(monCtx); err != nil {
			slog.Warn("monitor start failed", "err", err)
		}
	}

	return monCancel
}

func (e *Executor) stopMonitors(cancel context.CancelFunc) {
	if cancel != nil {
		cancel()
	}
	for _, m := range e.monitors {
		if err := m.Stop(); err != nil {
			slog.Warn("monitor stop failed", "err", err)
		}
	}
	e.monitors = nil
}

func (e *Executor) checkStuck(taskID, reason string) {
	slog.Warn("monitor task stuck", "task_id", taskID, "reason", reason)
	e.emitMonitorAlert("stuck", taskID, reason)
	e.killProcess(taskID)
}

func (e *Executor) checkConflicts(taskIDs, files []string) {
	msg := fmt.Sprintf("conflict detected between %v on files %v", taskIDs, files)
	slog.Warn("monitor conflict detected", "task_ids", taskIDs, "files", files, "message", msg)
	for _, taskID := range taskIDs {
		e.emitMonitorAlert("conflict", taskID, msg)
	}
}
