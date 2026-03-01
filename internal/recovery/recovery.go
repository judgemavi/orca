package recovery

import (
	"fmt"
	"log/slog"
	"strings"

	"github.com/jasjeetmavi/orca/internal/interaction"
	"github.com/jasjeetmavi/orca/internal/state"
	"github.com/jasjeetmavi/orca/internal/task"
)

type taskStore interface {
	ListByStatus(status string) ([]*task.Task, error)
	Update(id string, fields map[string]interface{}) error
}

type interactionStore interface {
	MarkStaleAsFailed() error
	List(taskID string) ([]interaction.Interaction, error)
}

type runningInteractionStore interface {
	ListByStatus(status string) ([]interaction.Interaction, error)
	Finish(id, status string, opts ...interaction.FinishOption) error
}

type sessionReconciler interface {
	Reconcile() (int, error)
}

// Recover executes startup recovery for stale state after an unclean exit.
// Order is important and intentionally fixed:
//  1. reconcile stale PTY sessions
//  2. mark stale interactions as failed
//  3. reset run-phase running tasks: stopped when resumable, failed otherwise
func Recover(
	_ *state.DB,
	taskStore taskStore,
	interactionStore interactionStore,
	sessionMgr sessionReconciler,
) error {
	slog.Info("startup.recovery.begin")

	if sessionMgr != nil {
		marked, err := sessionMgr.Reconcile()
		if err != nil {
			return fmt.Errorf("reconcile sessions: %w", err)
		}
		slog.Info("startup.recovery.sessions.reconciled", "marked_exited", marked)
	}

	if interactionStore != nil {
		if err := interactionStore.MarkStaleAsFailed(); err != nil {
			return fmt.Errorf("mark stale interactions failed: %w", err)
		}
		slog.Info("startup.recovery.interactions.marked_failed")
	}

	if taskStore == nil || interactionStore == nil {
		slog.Info("startup.recovery.complete", "tasks_checked", 0, "tasks_stopped", 0, "tasks_failed", 0)
		return nil
	}

	runningTasks, err := taskStore.ListByStatus("running")
	if err != nil {
		return fmt.Errorf("list running tasks: %w", err)
	}

	stopped := 0
	failed := 0
	for _, tk := range runningTasks {
		interactions, err := interactionStore.List(tk.ID)
		if err != nil {
			return fmt.Errorf("list interactions for task %s: %w", tk.ID, err)
		}
		if len(interactions) == 0 {
			slog.Info("startup.recovery.task.unchanged", "task_id", tk.ID, "reason", "no_interactions")
			continue
		}

		latest := interactions[0]
		if latest.Phase != interaction.PhaseRun {
			slog.Info(
				"startup.recovery.task.unchanged",
				"task_id", tk.ID,
				"latest_interaction_id", latest.ID,
				"latest_phase", latest.Phase,
			)
			continue
		}

		nextStatus := "stopped"
		if strings.TrimSpace(tk.SessionID) == "" {
			nextStatus = "failed"
		}
		if err := taskStore.Update(tk.ID, map[string]interface{}{"status": nextStatus}); err != nil {
			return fmt.Errorf("set task %s %s: %w", tk.ID, nextStatus, err)
		}
		if nextStatus == "stopped" {
			stopped++
		} else {
			failed++
		}
		slog.Info(
			"startup.recovery.task.reset",
			"task_id", tk.ID,
			"status", nextStatus,
			"latest_interaction_id", latest.ID,
			"latest_phase", latest.Phase,
		)
	}

	slog.Info("startup.recovery.complete", "tasks_checked", len(runningTasks), "tasks_stopped", stopped, "tasks_failed", failed)
	return nil
}

// FailInFlightForShutdown marks running interactions as failed and moves
// run-phase task status to stopped only when resumable (session_id present).
func FailInFlightForShutdown(taskStore taskStore, interactionStore runningInteractionStore) (int, int, error) {
	if interactionStore == nil {
		return 0, 0, nil
	}

	running, err := interactionStore.ListByStatus("running")
	if err != nil {
		return 0, 0, fmt.Errorf("list running interactions: %w", err)
	}

	hasSessionByTaskID := map[string]bool{}
	if taskStore != nil {
		runningTasks, err := taskStore.ListByStatus("running")
		if err != nil {
			return 0, 0, fmt.Errorf("list running tasks: %w", err)
		}
		for _, tk := range runningTasks {
			hasSessionByTaskID[tk.ID] = strings.TrimSpace(tk.SessionID) != ""
		}
	}

	runFailed := 0
	otherFailed := 0
	for _, in := range running {
		if err := interactionStore.Finish(
			in.ID,
			"failed",
			interaction.WithError("operation interrupted: shutdown signal received"),
		); err != nil {
			return runFailed, otherFailed, fmt.Errorf("fail interaction %s: %w", in.ID, err)
		}

		if in.Phase != interaction.PhaseRun {
			otherFailed++
			continue
		}

		runFailed++
		if taskStore == nil || in.TaskID == nil || strings.TrimSpace(*in.TaskID) == "" {
			continue
		}

		nextStatus := "failed"
		if hasSessionByTaskID[*in.TaskID] {
			nextStatus = "stopped"
		}
		if err := taskStore.Update(*in.TaskID, map[string]interface{}{"status": nextStatus}); err != nil {
			return runFailed, otherFailed, fmt.Errorf("set task %s %s: %w", *in.TaskID, nextStatus, err)
		}
	}

	return runFailed, otherFailed, nil
}
