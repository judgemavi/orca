package commands

import (
	"database/sql"
	"fmt"
	"os"

	"github.com/jasjeetmavi/orca/internal/config"
	"github.com/jasjeetmavi/orca/internal/integrator"
	"github.com/jasjeetmavi/orca/internal/ops"
	"github.com/jasjeetmavi/orca/internal/sprint"
	"github.com/jasjeetmavi/orca/internal/task"
	"github.com/spf13/cobra"
)

func RegisterMerge(root *cobra.Command, r *Registry) {
	mergeCmd := &cobra.Command{Use: "merge", Short: "Merge approved tasks into integration branch", RunE: r.runMerge}
	mergeCmd.Flags().Bool("dry-run", false, "Print what would be merged without doing it")
	root.AddCommand(mergeCmd)
}

func (r *Registry) runMerge(cmd *cobra.Command, args []string) error {
	db, cfg, planner, _, err := r.loadRuntimeOrErr()
	if err != nil {
		return err
	}
	defer db.Close()

	dryRun, _ := cmd.Flags().GetBool("dry-run")

	var sprintID string
	err = db.QueryRow(`SELECT id FROM sprints WHERE status IN ('completed', 'failed') ORDER BY completed_at DESC LIMIT 1`).Scan(&sprintID)
	if err == sql.ErrNoRows {
		fmt.Println("No completed sprints to merge")
		return nil
	}
	if err != nil {
		return fmt.Errorf("query sprint: %w", err)
	}

	s, err := planner.Get(sprintID)
	if err != nil {
		return fmt.Errorf("get sprint: %w", err)
	}

	var taskIDs []string
	for _, id := range s.TaskIDs {
		t, err := planner.GetTask(id)
		if err != nil {
			return fmt.Errorf("get task %s: %w", id, err)
		}
		if t.Status == "approved" {
			taskIDs = append(taskIDs, id)
		}
	}
	if len(taskIDs) == 0 {
		fmt.Println("No approved tasks to merge")
		return nil
	}

	if dryRun {
		fmt.Println("Dry run — would merge:")
		for _, id := range taskIDs {
			t, _ := planner.GetTask(id)
			title := id
			if t != nil {
				title = t.Title
			}
			fmt.Printf("  ○ task-%s  %s\n", short(id), title)
		}
		return nil
	}

	if err := ops.WithOperation(db, "merge", sprintID, func() error {
		fmt.Printf("merge.started sprint=%s\n", short(sprintID))

		repoDir, _ := os.Getwd()
		ig := integrator.New(repoDir, cfg.Project.IntegrationBranch, cfg.Validation.Commands)
		store := task.NewStore(db)
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
		fmt.Printf("merge.completed sprint=%s\n", short(sprintID))
		fmt.Printf("\nMerged: %d merged, %d failed\n", len(merged), len(failed))
		return nil
	}); err != nil {
		return err
	}

	// Complete sprint if all tasks are now merged (or none remain).
	if done, err := sprint.TryComplete(db, sprintID); err != nil {
		warnf("check sprint completion: %v", err)
	} else if done {
		fmt.Printf("Sprint %s completed\n", short(sprintID))
	}

	return nil
}
