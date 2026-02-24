package commands

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/charmbracelet/huh"
	"github.com/jasjeetmavi/orca/internal/sprint"
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
	toolName, _ := cmd.Flags().GetString("tool")
	modelName, _ := cmd.Flags().GetString("model")

	for i, dep := range dependsOn {
		resolved, err := resolveTaskID(store, dep)
		if err != nil {
			return err
		}
		dependsOn[i] = resolved
	}

	t, err := store.Create(title, description, parentID, toolName)
	if err != nil {
		return fmt.Errorf("create task: %w", err)
	}
	if modelName != "" {
		if err := store.Update(t.ID, map[string]interface{}{"model": modelName}); err != nil {
			return fmt.Errorf("set model: %w", err)
		}
	}

	for _, depID := range dependsOn {
		if err := store.AddDependency(t.ID, depID); err != nil {
			return fmt.Errorf("add dependency: %w", err)
		}
	}

	fmt.Printf("Created task %s: %s\n", short(t.ID), title)
	if toolName != "" {
		fmt.Printf("  tool: %s\n", toolName)
	}
	if modelName != "" {
		fmt.Printf("  model: %s\n", modelName)
	}
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
		var extras []string
		if len(t.DependsOn) > 0 {
			shortened := make([]string, len(t.DependsOn))
			for i, d := range t.DependsOn {
				shortened[i] = short(d)
			}
			extras = append(extras, "depends on: "+strings.Join(shortened, ", "))
		}
		if t.AssignedTool != "" {
			extras = append(extras, "tool: "+t.AssignedTool)
		}
		if t.Model != "" {
			extras = append(extras, "model: "+t.Model)
		}
		if len(extras) > 0 {
			line += "      " + strings.Join(extras, "  ")
		}
		fmt.Println(line)
	}
	return nil
}

func (r *Registry) runTaskEdit(cmd *cobra.Command, args []string) error {
	db, cfg, _, _, err := r.loadRuntimeOrErr()
	if err != nil {
		return err
	}
	store := task.NewStore(db)
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
	fields := make(map[string]interface{})
	if cmd.Flags().Changed("title") {
		v, _ := cmd.Flags().GetString("title")
		fields["title"] = v
	}
	if cmd.Flags().Changed("description") {
		v, _ := cmd.Flags().GetString("description")
		fields["description"] = v
	}
	if cmd.Flags().Changed("prompt") {
		v, _ := cmd.Flags().GetString("prompt")
		fields["prompt"] = v
	}
	if cmd.Flags().Changed("status") {
		v, _ := cmd.Flags().GetString("status")
		fields["status"] = v
	}
	if cmd.Flags().Changed("tool") {
		v, _ := cmd.Flags().GetString("tool")
		fields["assigned_tool"] = v
	}
	if cmd.Flags().Changed("model") {
		v, _ := cmd.Flags().GetString("model")
		fields["model"] = v
	}
	if len(fields) == 0 {
		t, err := store.Get(id)
		if err != nil {
			return fmt.Errorf("get task: %w", err)
		}

		title := t.Title
		description := t.Description
		toolName := t.AssignedTool
		modelName := t.Model

		toolNames := make([]string, 0, len(cfg.Tools))
		for name := range cfg.Tools {
			toolNames = append(toolNames, name)
		}
		sort.Strings(toolNames)

		toolOpts := []huh.Option[string]{huh.NewOption("(none)", "")}
		for _, name := range toolNames {
			toolOpts = append(toolOpts, huh.NewOption(name, name))
		}

		if err := huh.NewForm(huh.NewGroup(
			huh.NewInput().Title("Title").Value(&title),
			huh.NewText().Title("Description").Value(&description),
			huh.NewSelect[string]().Title("Tool").Options(toolOpts...).Value(&toolName),
		)).Run(); err != nil {
			return err
		}

		if toolName != "" {
			if tc, ok := cfg.Tools[toolName]; ok && len(tc.Models) > 0 {
				modelOpts := []huh.Option[string]{huh.NewOption("(tool default)", "")}
				for _, m := range tc.Models {
					modelOpts = append(modelOpts, huh.NewOption(m, m))
				}
				if err := huh.NewSelect[string]().
					Title("Model").
					Options(modelOpts...).
					Value(&modelName).
					Run(); err != nil {
					return err
				}
			}
		}

		if title != t.Title {
			fields["title"] = title
		}
		if description != t.Description {
			fields["description"] = description
		}
		if toolName != t.AssignedTool {
			fields["assigned_tool"] = toolName
		}
		if modelName != t.Model {
			fields["model"] = modelName
		}

		if len(fields) == 0 {
			fmt.Println("No changes.")
			return nil
		}
	}
	if err := store.Update(id, fields); err != nil {
		return fmt.Errorf("update task: %w", err)
	}
	fmt.Printf("Updated task %s\n", short(id))
	return nil
}

func (r *Registry) runTaskDelete(cmd *cobra.Command, args []string) error {
	db, cfg, _, executor, err := r.loadRuntimeOrErr()
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

	sprintID := t.SprintID
	if err := store.Delete(id); err != nil {
		return fmt.Errorf("delete task: %w", err)
	}
	// Best-effort worktree cleanup.
	if _, statErr := os.Stat(filepath.Join(cfg.Project.WorktreeDir, "task-"+id)); statErr == nil {
		if rmErr := executor.Worktrees().Remove(id); rmErr != nil {
			warnf("cleanup worktree for %s: %v", short(id), rmErr)
		}
	}
	fmt.Printf("Deleted task %s: %s\n", short(t.ID), t.Title)
	// End sprint if all its tasks have been deleted.
	if sprintID != "" {
		if ended, err := sprint.TryComplete(db, sprintID); err != nil {
			warnf("check sprint after delete: %v", err)
		} else if ended {
			fmt.Printf("Sprint %s completed (no tasks remaining)\n", short(sprintID))
		}
	}
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
	if t.AssignedTool != "" {
		fmt.Printf("Tool: %s\n", t.AssignedTool)
	} else {
		fmt.Println("Tool: (none)")
	}
	if t.Model != "" {
		fmt.Printf("Model: %s\n", t.Model)
	} else {
		fmt.Println("Model: (none)")
	}

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

func (r *Registry) runTaskReopen(cmd *cobra.Command, args []string) error {
	db, store, err := r.openStoreOrErr()
	if err != nil {
		return err
	}
	defer db.Close()

	taskIDs := args
	if len(taskIDs) == 0 {
		taskIDs, err = pickTasks(store, "Failed tasks", statusFilter("failed"))
		if err != nil {
			return err
		}
	}

	var reopened int
	var lastReopenedID string
	for _, arg := range taskIDs {
		id, err := resolveTaskID(store, arg)
		if err != nil {
			errorf("%v", err)
			continue
		}

		t, err := store.Get(id)
		if err != nil {
			errorf("get task %s: %v", short(id), err)
			continue
		}
		if t.Status != "failed" {
			errorf("task %s is %q, not %q", short(id), t.Status, "failed")
			continue
		}

		if err := store.Update(id, map[string]interface{}{"status": "pending", "sprint_id": nil}); err != nil {
			errorf("reopen task %s: %v", short(id), err)
			continue
		}
		reopened++
		lastReopenedID = id
	}

	if reopened == 1 {
		fmt.Printf("Reopened task %s -> pending\n", short(lastReopenedID))
		return nil
	}
	if reopened > 1 {
		fmt.Printf("Reopened %d tasks -> pending\n", reopened)
	}
	return nil
}
