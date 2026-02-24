package commands

import (
	"database/sql"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/charmbracelet/huh"
	"github.com/jasjeetmavi/orca/internal/ops"
	"github.com/spf13/cobra"
)

func (r *Registry) runSprintPlan(cmd *cobra.Command, args []string) error {
	db, cfg, planner, _, err := r.loadRuntimeOrErr()
	if err != nil {
		return err
	}
	defer db.Close()

	active, err := planner.GetActive()
	if err != nil {
		return fmt.Errorf("check active sprint: %w", err)
	}
	if active != nil {
		return fmt.Errorf("sprint %s already active (status: %s)", short(active.ID), active.Status)
	}

	s, err := planner.Plan(cfg.Workers.MaxParallel)
	if err != nil {
		return fmt.Errorf("plan sprint: %w", err)
	}

	opts := make([]huh.Option[string], len(s.TaskIDs))
	for i, id := range s.TaskIDs {
		label := short(id)
		if t, err := planner.GetTask(id); err == nil && t != nil {
			label = fmt.Sprintf("%s  %s", short(id), t.Title)
		}
		opts[i] = huh.NewOption(label, id).Selected(true)
	}
	var selected []string
	if err := huh.NewMultiSelect[string]().Title("Sprint tasks").Options(opts...).Value(&selected).Run(); err != nil {
		return err
	}
	selectedSet := make(map[string]struct{}, len(selected))
	for _, id := range selected {
		selectedSet[id] = struct{}{}
	}
	for _, id := range s.TaskIDs {
		if _, ok := selectedSet[id]; ok {
			continue
		}
		if err := planner.RemoveTaskFromSprint(s.ID, id); err != nil {
			return fmt.Errorf("remove task %s from sprint: %w", id, err)
		}
	}
	s.TaskIDs = selected

	fmt.Printf("Sprint %s planned (%d tasks)\n\n", short(s.ID), len(s.TaskIDs))
	for _, id := range s.TaskIDs {
		t, err := planner.GetTask(id)
		if err != nil {
			return fmt.Errorf("get task %s: %w", id, err)
		}
		fmt.Printf("  %s %s  %s\n", statusIcon(t.Status), short(t.ID), t.Title)
	}
	return nil
}

func (r *Registry) runSprintStart(cmd *cobra.Command, args []string) error {
	db, _, planner, executor, err := r.loadRuntimeOrErr()
	if err != nil {
		return err
	}
	defer db.Close()

	active, err := planner.GetActive()
	if err != nil {
		return fmt.Errorf("get active sprint: %w", err)
	}
	if active == nil {
		return fmt.Errorf("no active sprint — run 'orca sprint plan' first")
	}
	if active.Status != "planning" {
		return fmt.Errorf("sprint %s is %s, not planning", short(active.ID), active.Status)
	}
	errCancelled := errors.New("cancelled")
	err = ops.WithOperation(db, "sprint_start", active.ID, func() error {
		pidPath := filepath.Join(".orca", "sprint.pid")
		_ = os.WriteFile(pidPath, []byte(strconv.Itoa(os.Getpid())), 0644)
		defer os.Remove(pidPath)

		var cancelled atomic.Bool
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		go func() {
			sig := <-sigCh
			fmt.Printf("\nReceived %s, cancelling sprint...\n", sig)
			cancelled.Store(true)
			executor.Cancel()
		}()

		fmt.Printf("Starting sprint %s...\n\n", short(active.ID))
		fmt.Printf("sprint.started  sprint=%s\n", short(active.ID))
		results, err := executor.Run(active)
		signal.Stop(sigCh)
		if err != nil {
			return fmt.Errorf("run sprint: %w", err)
		}

		if cancelled.Load() {
			if cleanupErr := executor.Cleanup(active); cleanupErr != nil {
				warnf("worktree cleanup: %v", cleanupErr)
			}
			if resetErr := planner.ResetSprintTasks(active.ID); resetErr != nil {
				warnf("reset tasks: %v", resetErr)
			}
			fmt.Println("Sprint cancelled. Tasks reverted to pending.")
			return errCancelled
		}

		var succeeded, failed int
		for _, rt := range results {
			t, _ := planner.GetTask(rt.TaskID)
			title := rt.TaskID
			if t != nil {
				title = t.Title
			}
			fmt.Printf("sprint.progress task=%s status=%s duration=%s\n", short(rt.TaskID), rt.Status, rt.Duration.Round(time.Second))
			fmt.Printf("  %s %s  %s  (%s)\n", statusIcon(rt.Status), short(rt.TaskID), title, rt.Duration.Round(time.Second))
			if rt.Status == "failed" {
				failed++
				if rt.Stderr != "" {
					stderr := rt.Stderr
					if len(stderr) > 500 {
						stderr = stderr[:500] + "..."
					}
					fmt.Printf("    stderr: %s\n", stderr)
				}
			} else {
				succeeded++
			}
		}
		fmt.Printf("sprint.completed sprint=%s\n", short(active.ID))
		fmt.Printf("\nSprint complete: %d succeeded, %d failed\n", succeeded, failed)
		return nil
	})
	if errors.Is(err, errCancelled) {
		return nil
	}
	return err
}

func (r *Registry) runSprintReset(cmd *cobra.Command, args []string) error {
	db, _, planner, executor, err := r.loadRuntimeOrErr()
	if err != nil {
		return err
	}
	defer db.Close()

	active, err := planner.GetActive()
	if err != nil {
		return fmt.Errorf("get active sprint: %w", err)
	}

	if active == nil {
		var sprintID string
		err := db.QueryRow(`SELECT id FROM sprints ORDER BY created_at DESC LIMIT 1`).Scan(&sprintID)
		if err == sql.ErrNoRows {
			fmt.Println("No sprints to reset")
			return nil
		}
		if err != nil {
			return fmt.Errorf("get latest sprint: %w", err)
		}

		s, err := planner.Get(sprintID)
		if err != nil {
			return fmt.Errorf("get sprint: %w", err)
		}
		if s.Status == "completed" || s.Status == "failed" {
			active = s
		} else {
			fmt.Println("No active or recent sprint to reset")
			return nil
		}
	}

	confirm := false
	if err := huh.NewConfirm().
		Title(fmt.Sprintf("Reset sprint %s?", short(active.ID))).
		Description("Tasks will revert to pending and worktrees will be cleaned up.").
		Value(&confirm).Run(); err != nil {
		return err
	}
	if !confirm {
		return nil
	}

	if err := executor.Cleanup(active); err != nil {
		warnf("worktree cleanup: %v", err)
	}
	if err := planner.ResetSprintTasks(active.ID); err != nil {
		return fmt.Errorf("reset tasks: %w", err)
	}
	if err := planner.Fail(active.ID); err != nil {
		return fmt.Errorf("fail sprint: %w", err)
	}

	fmt.Printf("Sprint %s reset. Tasks reverted to pending.\n", short(active.ID))
	return nil
}

func (r *Registry) runSprintCancel(cmd *cobra.Command, args []string) error {
	db, _, planner, _, err := r.loadRuntimeOrErr()
	if err != nil {
		return err
	}
	defer db.Close()

	active, err := planner.GetActive()
	if err != nil {
		return fmt.Errorf("get active sprint: %w", err)
	}
	if active == nil {
		fmt.Println("No active sprint to cancel")
		return nil
	}
	if active.Status != "running" {
		return fmt.Errorf("sprint %s is %s, not running", short(active.ID), active.Status)
	}
	return ops.WithOperation(db, "sprint_cancel", active.ID, func() error {
		pidData, err := os.ReadFile(filepath.Join(".orca", "sprint.pid"))
		if err != nil {
			return fmt.Errorf("read sprint PID file: %w (is a sprint running?)", err)
		}
		pid, err := strconv.Atoi(strings.TrimSpace(string(pidData)))
		if err != nil {
			return fmt.Errorf("parse sprint PID: %w", err)
		}

		proc, err := os.FindProcess(pid)
		if err != nil {
			return fmt.Errorf("find process %d: %w", pid, err)
		}
		if err := proc.Signal(syscall.SIGTERM); err != nil {
			return fmt.Errorf("signal process %d: %w", pid, err)
		}

		fmt.Printf("Sprint %s cancelled. Sent SIGTERM to pid %d.\n", short(active.ID), pid)
		fmt.Println("Tasks will be reverted to pending.")
		return nil
	})
}

func (r *Registry) runSprintResume(cmd *cobra.Command, args []string) error {
	db, cfg, planner, _, err := r.loadRuntimeOrErr()
	if err != nil {
		return err
	}
	defer db.Close()

	orphans, err := planner.RecoverOrphans(cfg.Project.WorktreeDir, cfg.Project.IntegrationBranch)
	if err != nil {
		return fmt.Errorf("detect orphans: %w", err)
	}
	if len(orphans) == 0 {
		fmt.Println("No orphaned tasks found.")
		return nil
	}

	fmt.Printf("Found %d orphaned task(s):\n", len(orphans))
	for _, o := range orphans {
		status := "no work done"
		if o.HasCommits {
			status = "has commits -> moving to review"
		} else {
			status = "no commits -> marking failed"
		}
		fmt.Printf("  %s: %s\n", o.TaskID, status)
		if err := planner.ResolveOrphan(o.TaskID, o.HasCommits); err != nil {
			return fmt.Errorf("resolve orphan %s: %w", o.TaskID, err)
		}
	}

	active, err := planner.GetActive()
	if err != nil {
		return fmt.Errorf("get active sprint: %w", err)
	}
	if active != nil && active.Status == "running" {
		if err := planner.RecoverSprint(active.ID); err != nil {
			return fmt.Errorf("recover sprint %s: %w", active.ID, err)
		}
		fmt.Printf("Sprint %s marked as failed (was running).\n", short(active.ID))
	}

	fmt.Println("Recovery complete. Run 'orca sprint plan' to start a new sprint.")
	return nil
}
