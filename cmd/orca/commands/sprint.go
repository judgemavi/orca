package commands

import (
	"database/sql"
	"encoding/json"
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
	"github.com/jasjeetmavi/orca/internal/config"
	"github.com/jasjeetmavi/orca/internal/ops"
	"github.com/jasjeetmavi/orca/internal/review"
	"github.com/jasjeetmavi/orca/internal/task"
	"github.com/spf13/cobra"
)

func RegisterSprint(root *cobra.Command, r *Registry) {
	sprintCmd := &cobra.Command{
		Use:   "sprint",
		Short: "Manage sprint execution",
		RunE: func(cmd *cobra.Command, args []string) error {
			return cmd.Help()
		},
	}
	sprintCmd.AddCommand(&cobra.Command{Use: "plan", Short: "Select next batch of tasks for sprint", RunE: r.runSprintPlan})
	sprintCmd.AddCommand(&cobra.Command{Use: "start", Short: "Execute current sprint batch", RunE: r.runSprintStart})
	sprintCmd.AddCommand(&cobra.Command{Use: "status", Short: "Check worker progress", RunE: r.runSprintStatus})
	sprintCmd.AddCommand(&cobra.Command{Use: "assign [task-id...]", Short: "Add tasks to the current sprint", Args: cobra.ArbitraryArgs, RunE: r.runSprintAssign})
	sprintCmd.AddCommand(&cobra.Command{Use: "unassign [task-id...]", Short: "Remove tasks from the current sprint", Args: cobra.ArbitraryArgs, RunE: r.runSprintUnassign})

	reviewCmd := &cobra.Command{Use: "review", Short: "Review completed sprint work", RunE: r.runSprintReview}
	reviewCmd.Flags().Bool("verbose", false, "Show full diffs")
	reviewCmd.Flags().Bool("auto", false, "Run automated LLM review on each task")
	reviewCmd.Flags().String("review-tool", "", "Tool to use for automated review")
	sprintCmd.AddCommand(reviewCmd)
	sprintCmd.AddCommand(&cobra.Command{Use: "resume", Short: "Recover and resume an interrupted sprint", RunE: r.runSprintResume})

	sprintCmd.AddCommand(&cobra.Command{Use: "reset", Short: "Reset active sprint (cleanup worktrees, revert tasks to pending)", RunE: r.runSprintReset})
	sprintCmd.AddCommand(&cobra.Command{Use: "cancel", Short: "Cancel running sprint and kill workers", RunE: r.runSprintCancel})
	root.AddCommand(sprintCmd)
}

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

func (r *Registry) runSprintStatus(cmd *cobra.Command, args []string) error {
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
		fmt.Println("No active sprint")
		return nil
	}
	fmt.Printf("Sprint %s (%s)\n\n", short(active.ID), active.Status)
	for _, id := range active.TaskIDs {
		t, err := planner.GetTask(id)
		if err != nil {
			return fmt.Errorf("get task %s: %w", id, err)
		}
		fmt.Printf("  %s %s  %s\n", statusIcon(t.Status), short(t.ID), t.Title)
	}
	return nil
}

func (r *Registry) runSprintAssign(cmd *cobra.Command, args []string) error {
	db, cfg, planner, _, err := r.loadRuntimeOrErr()
	if err != nil {
		return err
	}
	defer db.Close()

	store := task.NewStore(db)
	active, err := planner.GetActive()
	if err != nil {
		return fmt.Errorf("get active sprint: %w", err)
	}
	if active == nil {
		active, err = planner.CreateEmpty()
		if err != nil {
			return fmt.Errorf("create sprint: %w", err)
		}
	}
	if active.Status != "planning" {
		return fmt.Errorf("sprint is running, cannot assign tasks")
	}
	if len(args) == 0 {
		ids, err := pickTasks(store, "Assign to sprint", statusFilter("pending"))
		if err != nil {
			return err
		}
		args = ids
	}

	var assigned int
	var lastAssignedID string
	for _, arg := range args {
		id, err := resolveTaskID(store, arg)
		if err != nil {
			errorf("%v", err)
			continue
		}
		if err := planner.AddTaskToSprintWithLimit(active.ID, id, cfg.Workers.MaxParallel); err != nil {
			errorf("%v", err)
			continue
		}
		assigned++
		lastAssignedID = id
	}
	if assigned == 1 {
		fmt.Printf("Assigned task %s to sprint %s (planning)\n", short(lastAssignedID), short(active.ID))
		return nil
	}
	if assigned > 1 {
		fmt.Printf("Assigned %d tasks to sprint %s (planning)\n", assigned, short(active.ID))
	}
	return nil
}

func (r *Registry) runSprintUnassign(cmd *cobra.Command, args []string) error {
	db, _, planner, _, err := r.loadRuntimeOrErr()
	if err != nil {
		return err
	}
	defer db.Close()

	store := task.NewStore(db)
	active, err := planner.GetActive()
	if err != nil {
		return fmt.Errorf("get active sprint: %w", err)
	}
	if active == nil {
		return fmt.Errorf("no active sprint")
	}
	if active.Status != "planning" {
		return fmt.Errorf("sprint is running, cannot unassign tasks")
	}
	if len(args) == 0 {
		sprintFilter := func(t *task.Task) bool {
			for _, id := range active.TaskIDs {
				if t.ID == id {
					return true
				}
			}
			return false
		}
		ids, err := pickTasks(store, "Remove from sprint", sprintFilter)
		if err != nil {
			return err
		}
		args = ids
	}

	var removed int
	var lastRemovedID string
	for _, arg := range args {
		id, err := resolveTaskID(store, arg)
		if err != nil {
			errorf("%v", err)
			continue
		}
		if err := planner.RemoveTaskFromSprint(active.ID, id); err != nil {
			errorf("%v", err)
			continue
		}
		removed++
		lastRemovedID = id
	}
	if removed == 1 {
		fmt.Printf("Removed task %s from sprint %s\n", short(lastRemovedID), short(active.ID))
		return nil
	}
	if removed > 1 {
		fmt.Printf("Removed %d tasks from sprint %s\n", removed, short(active.ID))
	}
	return nil
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

func (r *Registry) runSprintReview(cmd *cobra.Command, args []string) error {
	db, cfg, planner, _, err := r.loadRuntimeOrErr()
	if err != nil {
		return err
	}
	defer db.Close()

	verbose, _ := cmd.Flags().GetBool("verbose")
	auto, _ := cmd.Flags().GetBool("auto")
	reviewToolName, _ := cmd.Flags().GetString("review-tool")
	store := task.NewStore(db)

	var sprintID string
	err = db.QueryRow(`SELECT id FROM sprints WHERE status IN ('completed', 'failed') ORDER BY completed_at DESC LIMIT 1`).Scan(&sprintID)
	if err == sql.ErrNoRows {
		fmt.Println("No completed sprints to review")
		return nil
	}
	if err != nil {
		return fmt.Errorf("query sprint: %w", err)
	}

	s, err := planner.Get(sprintID)
	if err != nil {
		return fmt.Errorf("get sprint: %w", err)
	}

	fmt.Printf("Sprint %s (%s)\n\n", short(s.ID), s.Status)

	type taskArtifact struct {
		task       *task.Task
		diff       string
		durationMs int64
		hasArt     bool
	}
	var artifacts []taskArtifact

	for _, taskID := range s.TaskIDs {
		t, err := planner.GetTask(taskID)
		if err != nil {
			return fmt.Errorf("get task %s: %w", taskID, err)
		}

		var diff, stdout, stderr string
		var exitCode int
		var durationMs int64
		artErr := db.QueryRow(
			`SELECT diff, stdout, stderr, exit_code, duration_ms FROM artifacts WHERE task_id = ? AND sprint_id = ?`,
			taskID, sprintID,
		).Scan(&diff, &stdout, &stderr, &exitCode, &durationMs)

		ta := taskArtifact{task: t}
		icon := statusIcon(t.Status)
		if artErr == nil {
			ta.diff = diff
			ta.durationMs = durationMs
			ta.hasArt = true

			dur := time.Duration(durationMs) * time.Millisecond
			fmt.Printf("  %s %s  %s  (%s)\n", icon, short(t.ID), t.Title, dur.Round(time.Second))

			var files []string
			for _, line := range strings.Split(diff, "\n") {
				if strings.HasPrefix(line, "+++ b/") {
					files = append(files, strings.TrimPrefix(line, "+++ b/"))
				}
			}
			if len(files) > 0 {
				fmt.Printf("    files: %s\n", strings.Join(files, ", "))
			}
			if verbose && diff != "" {
				fmt.Printf("\n%s\n", diff)
			}

			var qualityJSON sql.NullString
			qErr := db.QueryRow("SELECT quality_json FROM artifacts WHERE task_id = ? ORDER BY created_at DESC LIMIT 1", taskID).Scan(&qualityJSON)
			if qErr == nil && qualityJSON.Valid && qualityJSON.String != "" {
				var q map[string]interface{}
				if json.Unmarshal([]byte(qualityJSON.String), &q) == nil {
					if scope, ok := q["scope"].(map[string]interface{}); ok {
						if flags, ok := scope["flags"].([]interface{}); ok && len(flags) > 0 {
							fmt.Println("  Quality flags:")
							for _, f := range flags {
								fmt.Printf("    ! %v\n", f)
							}
						}
					}
					if td, ok := q["test_delta"].(map[string]interface{}); ok {
						if failures, ok := td["new_failures"].([]interface{}); ok && len(failures) > 0 {
							fmt.Printf("  Test regressions: %d\n", len(failures))
						}
					}
				}
			}
		} else {
			fmt.Printf("  %s %s  %s\n", icon, short(t.ID), t.Title)
		}
		if !auto && (t.Status == "review" || t.Status == "approved") {
			action := "skip"
			if err := huh.NewSelect[string]().
				Title(fmt.Sprintf("Task %s: %s", short(t.ID), t.Title)).
				Options(
					huh.NewOption("Approve", "approve"),
					huh.NewOption("Skip", "skip"),
				).
				Value(&action).Run(); err != nil {
				return err
			}
			if action == "approve" {
				if err := store.Update(t.ID, map[string]interface{}{"status": "approved"}); err != nil {
					return fmt.Errorf("approve task %s: %w", t.ID, err)
				}
			}
		}
		artifacts = append(artifacts, ta)
	}

	if !auto {
		return nil
	}

	repoDir, _ := os.Getwd()
	resolveReviewTool := func(taskTool string) (config.ToolConfig, error) {
		if reviewToolName != "" {
			tc, ok := cfg.Tools[reviewToolName]
			if !ok {
				return config.ToolConfig{}, fmt.Errorf("review tool %q not found in config", reviewToolName)
			}
			return tc, nil
		}
		for name, tc := range cfg.Tools {
			if name != taskTool {
				return tc, nil
			}
		}
		for _, tc := range cfg.Tools {
			return tc, nil
		}
		return config.ToolConfig{}, fmt.Errorf("no tools configured")
	}

	return ops.WithOperation(db, "review", s.ID, func() error {
		fmt.Printf("\nRunning automated review...\n")
		fmt.Printf("review.started sprint=%s\n", short(s.ID))

		var inputs []review.ReviewInput
		var toolForReview config.ToolConfig
		for _, ta := range artifacts {
			if !ta.hasArt || ta.diff == "" || ta.task.Status != "approved" {
				continue
			}
			inputs = append(inputs, review.ReviewInput{TaskID: ta.task.ID, Title: ta.task.Title, Description: ta.task.Description, Diff: ta.diff})
			if toolForReview.Binary == "" {
				tc, err := resolveReviewTool(ta.task.AssignedTool)
				if err != nil {
					return fmt.Errorf("resolve review tool: %w", err)
				}
				toolForReview = tc
			}
		}
		if len(inputs) == 0 {
			fmt.Println("No approved tasks with diffs to review.")
			return nil
		}

		reviewer := review.New(toolForReview, repoDir)
		results, err := reviewer.ReviewBatch(inputs)
		if err != nil {
			return fmt.Errorf("run reviews: %w", err)
		}

		fmt.Println()
		var approved, rejected int
		for _, rt := range results {
			t, _ := planner.GetTask(rt.TaskID)
			title := rt.TaskID
			if t != nil {
				title = t.Title
			}
			if rt.Approved {
				approved++
				fmt.Printf("review.progress task=%s status=approved\n", short(rt.TaskID))
				fmt.Printf("  ✓ Approved: %s\n", title)
			} else {
				rejected++
				fmt.Printf("review.progress task=%s status=rejected\n", short(rt.TaskID))
				fmt.Printf("  ✗ Rejected: %s\n    feedback: %s\n", title, rt.Feedback)
			}
		}
		fmt.Printf("review.completed sprint=%s\n", short(s.ID))
		fmt.Printf("\nReview: %d approved, %d rejected\n", approved, rejected)
		return nil
	})
}
