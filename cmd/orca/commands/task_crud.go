package commands

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/charmbracelet/huh"
	"github.com/jasjeetmavi/orca/internal/task"
	"github.com/spf13/cobra"
)

func (r *Registry) runTaskAdd(cmd *cobra.Command, args []string) error {
	db, store, err := r.openStoreOrErr()
	if err != nil {
		return err
	}
	defer db.Close()

	title := strings.Join(args, " ")
	description, _ := cmd.Flags().GetString("description")
	parentID, _ := cmd.Flags().GetString("parent")
	dependsOn, _ := cmd.Flags().GetStringSlice("depends-on")

	for i, dep := range dependsOn {
		resolved, err := resolveTaskID(store, dep)
		if err != nil {
			return err
		}
		dependsOn[i] = resolved
	}

	t, err := store.Create(title, description, parentID)
	if err != nil {
		return fmt.Errorf("create task: %w", err)
	}

	for _, depID := range dependsOn {
		if err := store.AddDependency(t.ID, depID); err != nil {
			return fmt.Errorf("add dependency: %w", err)
		}
	}

	fmt.Printf("Created task %s: %s\n", short(t.ID), title)
	if len(dependsOn) > 0 {
		shortened := make([]string, len(dependsOn))
		for i, d := range dependsOn {
			shortened[i] = short(d)
		}
		fmt.Printf("  depends on: %s\n", strings.Join(shortened, ", "))
	}
	return nil
}

func (r *Registry) runTaskList(cmd *cobra.Command, args []string) error {
	db, store, err := r.openStoreOrErr()
	if err != nil {
		return err
	}
	defer db.Close()

	tasks, err := store.List()
	if err != nil {
		return fmt.Errorf("list tasks: %w", err)
	}
	if len(tasks) == 0 {
		fmt.Println("No tasks.")
		return nil
	}

	for _, t := range tasks {
		line := fmt.Sprintf("%s %s  %s", statusIcon(t.Status), short(t.ID), t.Title)
		if len(t.DependsOn) > 0 {
			shortened := make([]string, len(t.DependsOn))
			for i, d := range t.DependsOn {
				shortened[i] = short(d)
			}
			line += "      depends on: " + strings.Join(shortened, ", ")
		}
		fmt.Println(line)
	}
	return nil
}

func (r *Registry) runTaskEdit(cmd *cobra.Command, args []string) error {
	db, store, err := r.openStoreOrErr()
	if err != nil {
		return err
	}
	defer db.Close()

	var id string
	if len(args) > 0 {
		id, err = resolveTaskID(store, args[0])
	} else {
		id, err = pickTask(store, "Task", statusFilter())
	}
	if err != nil {
		return err
	}

	fields := task.UpdateFields{}
	hasUpdates := false
	if cmd.Flags().Changed("title") {
		v, _ := cmd.Flags().GetString("title")
		fields.Title = task.Ptr(v)
		hasUpdates = true
	}
	if cmd.Flags().Changed("description") {
		v, _ := cmd.Flags().GetString("description")
		fields.Description = task.Ptr(v)
		hasUpdates = true
	}
	if cmd.Flags().Changed("plan") {
		v, _ := cmd.Flags().GetString("plan")
		fields.Plan = task.Ptr(v)
		hasUpdates = true
	}
	if cmd.Flags().Changed("status") {
		v, _ := cmd.Flags().GetString("status")
		fields.Status = task.Ptr(v)
		hasUpdates = true
	}
	if !hasUpdates {
		return fmt.Errorf("no fields provided (use --title, --description, --plan, or --status)")
	}

	if err := store.Update(id, fields); err != nil {
		return fmt.Errorf("update task: %w", err)
	}
	fmt.Printf("Updated task %s\n", short(id))
	return nil
}

func (r *Registry) runTaskDelete(cmd *cobra.Command, args []string) error {
	db, cfg, executor, err := r.loadRuntimeOrErr()
	if err != nil {
		return err
	}
	defer db.Close()
	store := task.NewStore(db)

	var id string
	if len(args) > 0 {
		id, err = resolveTaskID(store, args[0])
	} else {
		id, err = pickTask(store, "Task", statusFilter())
	}
	if err != nil {
		return err
	}
	t, err := store.Get(id)
	if err != nil {
		return fmt.Errorf("get task: %w", err)
	}

	yes, _ := cmd.Flags().GetBool("yes")
	if !yes {
		confirm := false
		if err := huh.NewConfirm().
			Title(fmt.Sprintf("Delete task %s?", short(t.ID))).
			Description(t.Title).
			Value(&confirm).
			Run(); err != nil {
			return err
		}
		if !confirm {
			fmt.Println("Aborted.")
			return nil
		}
	}

	if err := store.Delete(id); err != nil {
		return fmt.Errorf("delete task: %w", err)
	}
	if _, statErr := os.Stat(filepath.Join(cfg.Project.WorktreeDir, "task-"+id)); statErr == nil {
		if rmErr := executor.Worktrees().Remove(id); rmErr != nil {
			warnf("cleanup worktree for %s: %v", short(id), rmErr)
		}
	}
	fmt.Printf("Deleted task %s: %s\n", short(t.ID), t.Title)
	return nil
}

func (r *Registry) runTaskShow(cmd *cobra.Command, args []string) error {
	db, store, err := r.openStoreOrErr()
	if err != nil {
		return err
	}
	defer db.Close()

	var id string
	if len(args) > 0 {
		id, err = resolveTaskID(store, args[0])
	} else {
		id, err = pickTask(store, "Task", statusFilter())
	}
	if err != nil {
		return err
	}
	t, err := store.Get(id)
	if err != nil {
		return fmt.Errorf("get task: %w", err)
	}

	fmt.Printf("ID: %s\n", t.ID)
	fmt.Printf("Title: %s\n", t.Title)
	fmt.Printf("Description: %s\n", t.Description)
	fmt.Printf("Status: %s\n", t.Status)

	if len(t.DependsOn) == 0 {
		fmt.Println("Dependencies: (none)")
	} else {
		shortened := make([]string, len(t.DependsOn))
		for i, dep := range t.DependsOn {
			shortened[i] = short(dep)
		}
		fmt.Printf("Dependencies: %s\n", strings.Join(shortened, ", "))
	}

	fmt.Println("Plan:")
	if strings.TrimSpace(t.Plan) == "" {
		fmt.Println("(none)")
	} else {
		fmt.Println(t.Plan)
	}
	return nil
}

func (r *Registry) runTaskStop(cmd *cobra.Command, args []string) error {
	db, _, exec, err := r.loadRuntimeOrErr()
	if err != nil {
		return err
	}
	defer db.Close()

	store := task.NewStore(db)

	var id string
	if len(args) > 0 {
		id, err = resolveTaskID(store, args[0])
	} else {
		id, err = pickTask(store, "Running task", statusFilter("running"))
	}
	if err != nil {
		return err
	}

	tk, err := store.Get(id)
	if err != nil {
		return fmt.Errorf("get task %s: %w", short(id), err)
	}
	if tk.Status != "running" {
		return fmt.Errorf("task %s is %q, only running tasks can be stopped", short(id), tk.Status)
	}

	if err := exec.StopTask(id); err != nil {
		return fmt.Errorf("stop task %s: %w", short(id), err)
	}
	if err := store.Update(id, task.UpdateFields{Status: task.Ptr("stopped")}); err != nil {
		return fmt.Errorf("set task %s stopped: %w", short(id), err)
	}
	fmt.Printf("Stopped task %s\n", short(id))
	return nil
}

func (r *Registry) runTaskResume(cmd *cobra.Command, args []string) error {
	db, _, exec, err := r.loadRuntimeOrErr()
	if err != nil {
		return err
	}
	defer db.Close()

	store := task.NewStore(db)

	var id string
	if len(args) > 0 {
		id, err = resolveTaskID(store, args[0])
	} else {
		id, err = pickTask(store, "Stopped task", statusFilter("stopped"))
	}
	if err != nil {
		return err
	}

	tk, err := store.Get(id)
	if err != nil {
		return fmt.Errorf("get task %s: %w", short(id), err)
	}
	if tk.Status != "stopped" {
		return fmt.Errorf("task %s is %q, only stopped tasks can be resumed", short(id), tk.Status)
	}
	if tk.SessionID == "" {
		return fmt.Errorf("task %s cannot resume without session_id", short(id))
	}

	done := make(chan struct{})
	go renderSpinner("Resuming task "+short(id), done)
	result, err := exec.ResumeTask(id)
	close(done)
	if err != nil {
		return fmt.Errorf("resume task %s: %w", short(id), err)
	}
	fmt.Printf("%s %s  %s  (%s)\n", statusIcon(result.Status), short(result.TaskID), tk.Title, result.Duration.Round(time.Second))
	fmt.Printf("Resumed task %s finished with status: %s\n", short(id), result.Status)
	return nil
}

func (r *Registry) runTaskAddDep(cmd *cobra.Command, args []string) error {
	db, store, err := r.openStoreOrErr()
	if err != nil {
		return err
	}
	defer db.Close()

	taskID, err := resolveTaskID(store, args[0])
	if err != nil {
		return fmt.Errorf("resolve task: %w", err)
	}
	dependsOnID, err := resolveTaskID(store, args[1])
	if err != nil {
		return fmt.Errorf("resolve dependency: %w", err)
	}

	taskToUpdate, err := store.Get(taskID)
	if err != nil {
		return fmt.Errorf("get task: %w", err)
	}
	dependencyTask, err := store.Get(dependsOnID)
	if err != nil {
		return fmt.Errorf("get dependency: %w", err)
	}

	if err := store.AddDependency(taskID, dependsOnID); err != nil {
		return fmt.Errorf("add dependency: %w", err)
	}

	fmt.Printf("Added dependency: %s %s depends on %s %s\n",
		short(taskToUpdate.ID), taskToUpdate.Title, short(dependencyTask.ID), dependencyTask.Title)
	return nil
}
