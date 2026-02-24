package commands

import (
	"fmt"

	"github.com/jasjeetmavi/orca/internal/task"
	"github.com/spf13/cobra"
)

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
