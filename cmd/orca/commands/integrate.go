package commands

import (
	"database/sql"
	"fmt"
	"os"

	"github.com/jasjeetmavi/orca/internal/config"
	"github.com/jasjeetmavi/orca/internal/integrator"
	"github.com/jasjeetmavi/orca/internal/task"
	"github.com/spf13/cobra"
)

func RegisterIntegrate(root *cobra.Command, r *Registry) {
	integrateCmd := &cobra.Command{Use: "integrate", Short: "Merge approved tasks into integration branch", RunE: r.runIntegrate}
	integrateCmd.Flags().Bool("dry-run", false, "Print what would be merged without doing it")
	root.AddCommand(integrateCmd)
}

func (r *Registry) runIntegrate(cmd *cobra.Command, args []string) error {
	db, cfg, planner, _, err := r.loadRuntimeOrErr()
	if err != nil {
		return err
	}
	defer db.Close()

	dryRun, _ := cmd.Flags().GetBool("dry-run")

	var sprintID string
	err = db.QueryRow(`SELECT id FROM sprints WHERE status IN ('completed', 'failed') ORDER BY completed_at DESC LIMIT 1`).Scan(&sprintID)
	if err == sql.ErrNoRows {
		fmt.Println("No completed sprints to integrate")
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
		fmt.Println("No approved tasks to integrate")
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

	if err := ensureOperationsTable(db); err != nil {
		return fmt.Errorf("ensure operations table: %w", err)
	}
	opID, err := createOperation(db, "integrate", sprintID)
	if err != nil {
		return fmt.Errorf("create operation: %w", err)
	}
	fmt.Printf("integrate.started sprint=%s operation=%s\n", short(sprintID), short(opID))

	repoDir, _ := os.Getwd()
	ig := integrator.New(repoDir, cfg.Project.IntegrationBranch, cfg.Validation.Commands)
	store := task.NewStore(db)
	ig.SetRerunConfig(cfg.Project.WorktreeDir, func(taskID string) (config.ToolConfig, error) {
		t, err := store.Get(taskID)
		if err != nil {
			return config.ToolConfig{}, err
		}
		toolName := t.AssignedTool
		if toolName == "" {
			for _, tc := range cfg.Tools {
				return tc, nil
			}
			return config.ToolConfig{}, fmt.Errorf("no tools configured")
		}
		tc, ok := cfg.Tools[toolName]
		if !ok {
			return config.ToolConfig{}, fmt.Errorf("tool %q not found", toolName)
		}
		return tc, nil
	})
	merged, failed, err := ig.MergeBatch(taskIDs)
	if err != nil {
		_ = failOperation(db, opID, err.Error())
		return fmt.Errorf("merge batch: %w", err)
	}

	for _, id := range merged {
		fmt.Printf("integrate.progress task=%s status=merged\n", short(id))
		if err := store.Update(id, map[string]interface{}{"status": "merged"}); err != nil {
			fmt.Fprintf(os.Stderr, "warning: set task %s merged: %v\n", short(id), err)
		}
		fmt.Printf("  ✓ Merged task-%s\n", short(id))
	}
	for _, id := range failed {
		fmt.Printf("integrate.progress task=%s status=failed\n", short(id))
		fmt.Printf("  ✗ Failed task-%s\n", short(id))
	}
	if err := completeOperation(db, opID, map[string]interface{}{"sprint_id": sprintID, "merged": merged, "failed": failed}); err != nil {
		return fmt.Errorf("complete operation: %w", err)
	}
	fmt.Printf("integrate.completed sprint=%s operation=%s\n", short(sprintID), short(opID))
	fmt.Printf("\nIntegrated: %d merged, %d failed\n", len(merged), len(failed))
	return nil
}
