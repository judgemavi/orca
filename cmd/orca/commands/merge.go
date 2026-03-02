package commands

import (
	"fmt"
	"os"
	"time"

	"github.com/jasjeetmavi/orca/internal/driver"
	"github.com/jasjeetmavi/orca/internal/integrator"
	"github.com/jasjeetmavi/orca/internal/interaction"
	"github.com/jasjeetmavi/orca/internal/task"
	"github.com/spf13/cobra"
)

func RegisterMerge(root *cobra.Command, r *Registry) {
	mergeCmd := &cobra.Command{Use: "merge", Short: "Merge approved tasks into integration branch", RunE: r.runMerge}
	mergeCmd.Flags().Bool("dry-run", false, "Print what would be merged without doing it")
	root.AddCommand(mergeCmd)
}

func (r *Registry) runMerge(cmd *cobra.Command, args []string) error {
	db, cfg, _, err := r.loadRuntimeOrErr()
	if err != nil {
		return err
	}
	defer db.Close()

	dryRun, _ := cmd.Flags().GetBool("dry-run")

	store := task.NewStore(db)
	tasks, err := store.List()
	if err != nil {
		return fmt.Errorf("list tasks: %w", err)
	}
	var taskIDs []string
	for _, t := range tasks {
		if t.Status == "approved" {
			taskIDs = append(taskIDs, t.ID)
		}
	}
	if len(taskIDs) == 0 {
		fmt.Println("No approved tasks to merge")
		return nil
	}

	if dryRun {
		fmt.Println("Dry run — would merge:")
		for _, id := range taskIDs {
			t, _ := store.Get(id)
			title := id
			if t != nil {
				title = t.Title
			}
			fmt.Printf("  ○ task-%s  %s\n", short(id), title)
		}
		return nil
	}

	interactions := interaction.NewStore(db, ".orca/interactions")
	return interaction.Wrap(interactions, nil, interaction.PhaseMerge, "orca", func(writer *interaction.Writer) error {
		fmt.Println("merge.started")

		repoDir, _ := os.Getwd()
		ig := integrator.New(repoDir, cfg.Project.IntegrationBranch, cfg.Validation.Commands, interactions)
		ig.OnPostMerge = func(taskID string) {
			if retroErr := runPostMergeRetro(cfg, db, repoDir, taskID); retroErr != nil {
				recordPostMergeFailure(interactions, taskID, "retro", retroErr)
				warnf("post-merge retro failed for task %s: %v (retry: orca tasks retro %s)", short(taskID), retroErr, taskID)
			}
		}
		ig.OnPostMergeBatchComplete = func(mergedTaskIDs []string) {
			if len(mergedTaskIDs) == 0 {
				return
			}
			if _, syncErr := runPostMergeSync(cfg, db, repoDir); syncErr != nil {
				for _, taskID := range mergedTaskIDs {
					recordPostMergeFailure(interactions, taskID, "sync", syncErr)
				}
				warnf("post-merge memory sync failed: %v (retry: orca memory sync)", syncErr)
			}
		}
		ig.SetRerunConfig(cfg.Project.WorktreeDir, func(taskID string) (string, driver.Driver, string, time.Duration, error) {
			if _, err := store.Get(taskID); err != nil {
				return "", nil, "", 0, err
			}
			toolName, d, err := cfg.ResolveToolForPhase(interaction.PhaseMerge, "")
			if err != nil {
				return "", nil, "", 0, err
			}
			model := cfg.ResolveModelForPhase(interaction.PhaseMerge, "", d)
			return toolName, d, model, 10 * time.Minute, nil
		})
		merged, failed, err := ig.MergeBatch(taskIDs)
		if err != nil {
			return fmt.Errorf("merge batch: %w", err)
		}

		for _, id := range merged {
			fmt.Printf("merge.progress task=%s status=merged\n", short(id))
			_ = writer.WriteString(fmt.Sprintf("merge.progress task=%s status=merged\n", id))
			if err := store.Update(id, task.UpdateFields{Status: task.Ptr("merged")}); err != nil {
				warnf("set task %s merged: %v", short(id), err)
			}
			fmt.Printf("  ✓ Merged task-%s\n", short(id))
		}
		for _, id := range failed {
			fmt.Printf("merge.progress task=%s status=failed\n", short(id))
			_ = writer.WriteString(fmt.Sprintf("merge.progress task=%s status=failed\n", id))
			fmt.Printf("  ✗ Failed task-%s\n", short(id))
		}
		fmt.Println("merge.completed")
		fmt.Printf("\nMerged: %d merged, %d failed\n", len(merged), len(failed))
		return nil
	})
}
