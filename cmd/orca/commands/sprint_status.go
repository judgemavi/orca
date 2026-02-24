package commands

import (
	"fmt"

	"github.com/spf13/cobra"
)

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
