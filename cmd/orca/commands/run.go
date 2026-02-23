package commands

import (
	"fmt"
	"os"
	"time"

	"github.com/jasjeetmavi/orca/internal/integrator"
	"github.com/spf13/cobra"
)

func RegisterRun(root *cobra.Command, r *Registry) {
	runCmd := &cobra.Command{Use: "run", Short: "Plan, start, review, and merge in one shot", RunE: r.runRun}
	runCmd.Flags().Bool("no-merge", false, "Skip auto-merge after success")
	root.AddCommand(runCmd)
}

func (r *Registry) runRun(cmd *cobra.Command, args []string) error {
	db, cfg, planner, executor, err := r.loadRuntimeOrErr()
	if err != nil {
		return err
	}
	defer db.Close()

	noMerge, _ := cmd.Flags().GetBool("no-merge")

	active, err := planner.GetActive()
	if err != nil {
		return fmt.Errorf("check active sprint: %w", err)
	}
	if active != nil {
		return fmt.Errorf("sprint %s already active — reset it first", short(active.ID))
	}

	s, err := planner.Plan(cfg.Workers.MaxParallel)
	if err != nil {
		return fmt.Errorf("plan: %w", err)
	}
	fmt.Printf("Planned sprint %s (%d tasks)\n", short(s.ID), len(s.TaskIDs))

	fmt.Println("Running...")
	results, err := executor.Run(s)
	if err != nil {
		return fmt.Errorf("run: %w", err)
	}

	var succeeded, failed int
	for _, rt := range results {
		t, _ := planner.GetTask(rt.TaskID)
		title := rt.TaskID
		if t != nil {
			title = t.Title
		}
		fmt.Printf("  %s %s  %s  (%s)\n", statusIcon(rt.Status), short(rt.TaskID), title, rt.Duration.Round(time.Second))
		if rt.Status == "failed" {
			failed++
		} else {
			succeeded++
		}
	}
	fmt.Printf("\n%d succeeded, %d failed\n", succeeded, failed)

	if failed > 0 || noMerge {
		return nil
	}

	repoDir, _ := os.Getwd()
	ig := integrator.New(repoDir, cfg.Project.IntegrationBranch, cfg.Validation.Commands)

	var taskIDs []string
	for _, rt := range results {
		if rt.Status == "approved" {
			taskIDs = append(taskIDs, rt.TaskID)
		}
	}

	merged, failedIDs, err := ig.MergeBatch(taskIDs)
	if err != nil {
		return fmt.Errorf("merge: %w", err)
	}
	fmt.Printf("\nMerged: %d merged, %d failed\n", len(merged), len(failedIDs))
	return nil
}
