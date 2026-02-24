package commands

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"strings"
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
