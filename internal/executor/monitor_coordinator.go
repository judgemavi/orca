package executor

import (
	"context"
	"database/sql"
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

	if (e.config.Orchestrator.CostBudget > 0 || e.config.Orchestrator.TaskBudget > 0) && e.interactions != nil && len(taskIDs) > 0 {
		taskBudget := e.config.Orchestrator.TaskBudget
		if taskBudget <= 0 {
			taskBudget = e.config.Orchestrator.CostBudget / float64(len(taskIDs))
		}
		budget := monitor.NewBudgetEnforcer(
			stuckCheckInterval,
			taskBudget,
			e.config.Orchestrator.CostBudget,
			e.checkBudget,
			func(taskID string, spent, limit float64) {
				msg := fmt.Sprintf("budget exceeded ($%.2f/$%.2f)", spent, limit)
				slog.Warn("monitor budget alert", "task_id", taskID, "spent", spent, "limit", limit, "message", msg)
				e.emitMonitorAlert("budget", taskID, msg)
				e.killProcess(taskID)
			},
			taskIDs,
		)
		e.monitors = append(e.monitors, budget)
	}

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

func (e *Executor) checkBudget(taskID string) float64 {
	var total sql.NullFloat64
	if err := e.db.QueryRow(
		`SELECT SUM(estimated_cost) FROM task_interactions WHERE task_id = ?`,
		taskID,
	).Scan(&total); err != nil {
		slog.Warn("monitor query task cost failed", "task_id", taskID, "err", err)
		return 0
	}
	if !total.Valid {
		return 0
	}
	return total.Float64
}
