package commands

import (
	"fmt"

	"github.com/jasjeetmavi/orca/internal/sprint"
	"github.com/jasjeetmavi/orca/internal/task"
	"github.com/spf13/cobra"
)

func newStatusCmd(r *Registry) *cobra.Command {
	return &cobra.Command{Use: "status", Short: "Show overall project status", RunE: r.runStatus}
}

func (r *Registry) runStatus(cmd *cobra.Command, args []string) error {
	db, cfg, _, _, err := r.loadRuntimeOrErr()
	if err != nil {
		return err
	}
	store := task.NewStore(db)
	defer db.Close()

	tasks, err := store.List()
	if err != nil {
		return fmt.Errorf("list tasks: %w", err)
	}

	counts := map[string]int{}
	for _, t := range tasks {
		counts[t.Status]++
	}

	planner := sprint.NewPlanner(db)
	active, err := planner.GetActive()
	if err != nil {
		return fmt.Errorf("get active sprint: %w", err)
	}

	fmt.Printf("Orca status: %s\n\n", cfg.Project.Name)
	fmt.Printf("Tasks: %d total\n", len(tasks))
	fmt.Printf("  ○ pending:     %d\n", counts["pending"])
	fmt.Printf("  ● in progress: %d\n", counts["in_sprint"]+counts["running"])
	fmt.Printf("  ✓ approved:    %d\n", counts["approved"])
	fmt.Printf("  ✗ failed:      %d\n", counts["failed"])

	if active != nil {
		fmt.Printf("\nSprint: %s (%s)\n", short(active.ID), active.Status)
	} else {
		fmt.Println("\nSprint: none active")
	}
	return nil
}
