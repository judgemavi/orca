package commands

import (
	"fmt"
	"os"
	"slices"
	"time"

	"github.com/jasjeetmavi/orca/internal/executor"
	"github.com/jasjeetmavi/orca/internal/integrator"
	"github.com/jasjeetmavi/orca/internal/interaction"
	"github.com/jasjeetmavi/orca/internal/task"
	"github.com/spf13/cobra"
)

func RegisterRun(root *cobra.Command, r *Registry) {
	runCmd := &cobra.Command{Use: "run", Short: "Run ready tasks (or specific task IDs)", RunE: r.runRun}
	runCmd.Flags().Bool("no-merge", false, "Skip auto-merge after success")
	root.AddCommand(runCmd)
}

func (r *Registry) runRun(cmd *cobra.Command, args []string) error {
	db, cfg, exec, err := r.loadRuntimeOrErr()
	if err != nil {
		return err
	}
	defer db.Close()

	noMerge, _ := cmd.Flags().GetBool("no-merge")
	store := task.NewStore(db)

	var taskIDs []string
	if len(args) > 0 {
		for _, arg := range args {
			id, resolveErr := resolveTaskID(store, arg)
			if resolveErr != nil {
				return resolveErr
			}
			tk, getErr := store.Get(id)
			if getErr != nil {
				return fmt.Errorf("get task %s: %w", id, getErr)
			}
			if !slices.Contains([]string{"pending", "planned"}, tk.Status) {
				return fmt.Errorf("task %s must be pending or planned to run (current: %s)", id, tk.Status)
			}
			taskIDs = append(taskIDs, id)
		}
	} else {
		ready, readyErr := store.GetReady()
		if readyErr != nil {
			return fmt.Errorf("get ready tasks: %w", readyErr)
		}
		if len(ready) == 0 {
			return fmt.Errorf("no ready tasks")
		}
		maxParallel := cfg.Workers.MaxParallel
		if maxParallel <= 0 {
			maxParallel = 1
		}
		if len(ready) > maxParallel {
			ready = ready[:maxParallel]
		}
		for _, t := range ready {
			taskIDs = append(taskIDs, t.ID)
		}
	}

	fmt.Printf("Running %d task(s)...\n", len(taskIDs))
	results, err := exec.RunBatch(taskIDs, executor.RunOpts{})
	if err != nil {
		return fmt.Errorf("run: %w", err)
	}

	var succeeded, failed int
	for _, rt := range results {
		t, _ := store.Get(rt.TaskID)
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
	ig := integrator.New(repoDir, cfg.Project.IntegrationBranch, cfg.Validation.Commands, interaction.NewStore(db, ".orca/interactions"))

	var mergeIDs []string
	for _, rt := range results {
		if rt.Status == "approved" || rt.Status == "review" {
			mergeIDs = append(mergeIDs, rt.TaskID)
		}
	}

	if len(mergeIDs) > 0 {
		merged, failedIDs, mergeErr := ig.MergeBatch(mergeIDs)
		if mergeErr != nil {
			return fmt.Errorf("merge: %w", mergeErr)
		}
		fmt.Printf("\nMerged: %d merged, %d failed\n", len(merged), len(failedIDs))
	}
	return nil
}
