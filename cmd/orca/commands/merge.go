package commands

import (
	"fmt"
	"os"

	"github.com/jasjeetmavi/orca/internal/config"
	"github.com/jasjeetmavi/orca/internal/integrator"
	"github.com/jasjeetmavi/orca/internal/ops"
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

	if err := ops.WithOperation(db, "merge", "", func() error {
		fmt.Println("merge.started")

		repoDir, _ := os.Getwd()
		ig := integrator.New(repoDir, cfg.Project.IntegrationBranch, cfg.Validation.Commands)
		ig.SetRerunConfig(cfg.Project.WorktreeDir, func(taskID string) (config.ToolConfig, error) {
			t, err := store.Get(taskID)
			if err != nil {
				return config.ToolConfig{}, err
			}
			_, tc, err := cfg.ResolveToolForPhase(t, "merge", "")
			if err != nil {
				return config.ToolConfig{}, err
			}
			return tc, nil
		})
		merged, failed, err := ig.MergeBatch(taskIDs)
		if err != nil {
			return fmt.Errorf("merge batch: %w", err)
		}

		for _, id := range merged {
			fmt.Printf("merge.progress task=%s status=merged\n", short(id))
			if err := store.Update(id, map[string]interface{}{"status": "merged"}); err != nil {
				warnf("set task %s merged: %v", short(id), err)
			}
			fmt.Printf("  ✓ Merged task-%s\n", short(id))
		}
		for _, id := range failed {
			fmt.Printf("merge.progress task=%s status=failed\n", short(id))
			fmt.Printf("  ✗ Failed task-%s\n", short(id))
		}
		fmt.Println("merge.completed")
		fmt.Printf("\nMerged: %d merged, %d failed\n", len(merged), len(failed))
		return nil
	}); err != nil {
		return err
	}
	return nil
}
