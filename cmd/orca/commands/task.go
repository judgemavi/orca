package commands

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"

	"github.com/charmbracelet/huh"
	"github.com/jasjeetmavi/orca/internal/config"
	"github.com/jasjeetmavi/orca/internal/integrator"
	planpkg "github.com/jasjeetmavi/orca/internal/plan"
	"github.com/jasjeetmavi/orca/internal/sprint"
	"github.com/jasjeetmavi/orca/internal/task"
	"github.com/spf13/cobra"
)

func RegisterTask(root *cobra.Command, r *Registry) {
	taskCmd := &cobra.Command{
		Use:     "tasks",
		Aliases: []string{"task"},
		Short:   "Manage tasks",
		RunE:    r.runTaskList,
	}

	addCmd := &cobra.Command{
		Use:   "add [title]",
		Short: "Add a task",
		Args:  cobra.MinimumNArgs(1),
		RunE:  r.runTaskAdd,
	}
	addCmd.Flags().String("description", "", "Task description")
	addCmd.Flags().String("parent", "", "Parent task ID")
	addCmd.Flags().StringSlice("depends-on", nil, "Task IDs this task depends on")
	addCmd.Flags().String("tool", "", "Assigned tool")
	addCmd.Flags().String("model", "", "Assigned model")
	taskCmd.AddCommand(addCmd)

	taskCmd.AddCommand(&cobra.Command{Use: "list", Short: "List tasks", RunE: r.runTaskList})

	editCmd := &cobra.Command{Use: "edit [id]", Short: "Edit a task", Args: cobra.MaximumNArgs(1), RunE: r.runTaskEdit}
	editCmd.Flags().String("title", "", "New title")
	editCmd.Flags().String("description", "", "New description")
	editCmd.Flags().String("prompt", "", "New prompt")
	editCmd.Flags().String("status", "", "New status")
	editCmd.Flags().String("tool", "", "Assigned tool")
	editCmd.Flags().String("model", "", "Assigned model")
	taskCmd.AddCommand(editCmd)

	deleteCmd := &cobra.Command{Use: "delete [task-id]", Short: "Delete a task", Args: cobra.MaximumNArgs(1), RunE: r.runTaskDelete}
	deleteCmd.Flags().BoolP("yes", "y", false, "Skip confirmation")
	taskCmd.AddCommand(deleteCmd)

	mergeCmd := &cobra.Command{Use: "merge [task-id]", Short: "Merge an approved task into integration branch", Args: cobra.MaximumNArgs(1), RunE: r.runTaskMerge}
	mergeCmd.Flags().Bool("auto", false, "Auto-resolve merge conflicts by rerunning task in worktree")
	taskCmd.AddCommand(mergeCmd)

	planCmd := &cobra.Command{Use: "plan [task-id]", Short: "Generate an implementation plan for a task", Args: cobra.MaximumNArgs(1), RunE: r.runTaskPlan}
	planCmd.Flags().Bool("save", false, "Save generated plan to the task")
	planCmd.Flags().Bool("edit", false, "Open generated plan in $EDITOR and save edits")
	planCmd.Flags().String("tool", "", "Tool to use for plan generation")
	planCmd.Flags().String("model", "", "Model to use for plan generation")
	taskCmd.AddCommand(planCmd)

	evaluateCmd := &cobra.Command{
		Use:   "evaluate [task-id]",
		Short: "Evaluate whether a task should be broken down before planning",
		Args:  cobra.MaximumNArgs(1),
		RunE:  r.runTaskEvaluate,
	}
	evaluateCmd.Flags().String("tool", "", "Tool to use for evaluation")
	evaluateCmd.Flags().String("model", "", "Model to use for evaluation")
	evaluateCmd.Flags().Bool("json", false, "Output raw JSON")
	taskCmd.AddCommand(evaluateCmd)

	taskCmd.AddCommand(&cobra.Command{Use: "show [task-id]", Short: "Show full task details", Args: cobra.MaximumNArgs(1), RunE: r.runTaskShow})
	taskCmd.AddCommand(&cobra.Command{Use: "reopen [task-id...]", Short: "Move failed tasks back to pending", Args: cobra.ArbitraryArgs, RunE: r.runTaskReopen})

	root.AddCommand(taskCmd)
}

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
		id, err = pickTask(store, "Task", allTasks)
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
		id, err = pickTask(store, "Task", allTasks)
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
			fmt.Fprintf(os.Stderr, "warning: cleanup worktree for %s: %v\n", short(id), rmErr)
		}
	}
	fmt.Printf("Deleted task %s: %s\n", short(t.ID), t.Title)
	// End sprint if all its tasks have been deleted.
	if sprintID != "" {
		planner := sprint.NewPlanner(db)
		if ended, err := planner.CompleteSprintIfEmpty(sprintID); err != nil {
			fmt.Fprintf(os.Stderr, "warning: check sprint after delete: %v\n", err)
		} else if ended {
			fmt.Printf("Sprint %s completed (no tasks remaining)\n", short(sprintID))
		}
	}
	return nil
}

func (r *Registry) runTaskMerge(cmd *cobra.Command, args []string) error {
	db, cfg, _, executor, err := r.loadRuntimeOrErr()
	if err != nil {
		return err
	}
	defer db.Close()

	auto, _ := cmd.Flags().GetBool("auto")
	store := task.NewStore(db)

	var id string
	if len(args) > 0 {
		id, err = resolveTaskID(store, args[0])
	} else {
		id, err = pickTask(store, "Approved task", approvedTasks)
	}
	if err != nil {
		return err
	}
	tk, err := store.Get(id)
	if err != nil {
		return fmt.Errorf("get task: %w", err)
	}
	if tk.Status != "approved" {
		return fmt.Errorf("only approved tasks can be merged (task %s is %s)", short(id), tk.Status)
	}
	for _, depID := range tk.DependsOn {
		dep, err := store.Get(depID)
		if err != nil {
			return fmt.Errorf("check dependency %s: %w", short(depID), err)
		}
		if dep.Status != "merged" {
			return fmt.Errorf("dependency %q (%s) must be merged first", dep.Title, short(dep.ID))
		}
	}

	if err := ensureOperationsTable(db); err != nil {
		return fmt.Errorf("ensure operations table: %w", err)
	}
	opID, err := createOperation(db, "merge", id)
	if err != nil {
		return fmt.Errorf("create operation: %w", err)
	}

	repoDir, _ := os.Getwd()
	ig := integrator.New(repoDir, cfg.Project.IntegrationBranch, cfg.Validation.Commands)
	if auto {
		ig.SetRerunConfig(cfg.Project.WorktreeDir, func(taskID string) (config.ToolConfig, error) {
			taskRow, err := store.Get(taskID)
			if err != nil {
				return config.ToolConfig{}, err
			}
			if taskRow.AssignedTool != "" {
				if tc, ok := cfg.Tools[taskRow.AssignedTool]; ok {
					return tc, nil
				}
				return config.ToolConfig{}, fmt.Errorf("tool %q not found", taskRow.AssignedTool)
			}
			for _, tc := range cfg.Tools {
				return tc, nil
			}
			return config.ToolConfig{}, fmt.Errorf("no tools configured")
		})
	}

	fmt.Printf("Merging task %s (op %s)\n", short(id), short(opID))
	if auto {
		fmt.Println("Auto-resolving conflicts is enabled.")
	}

	var mergeErr error
	if auto {
		mergeErr = ig.MergeWithRerun(id)
	} else {
		mergeErr = ig.MergeAndValidate(id)
	}
	if mergeErr != nil {
		_ = failOperation(db, opID, mergeErr.Error())
		if strings.Contains(strings.ToLower(mergeErr.Error()), "conflict") {
			worktreePath := filepath.Join(cfg.Project.WorktreeDir, "task-"+id)
			return fmt.Errorf("merge conflict for task %s (worktree: %s): %w", short(id), worktreePath, mergeErr)
		}
		return fmt.Errorf("merge task %s: %w", short(id), mergeErr)
	}

	if err := store.Update(id, map[string]interface{}{"status": "merged"}); err != nil {
		_ = failOperation(db, opID, err.Error())
		return fmt.Errorf("set merged status: %w", err)
	}
	if err := executor.Worktrees().Remove(id); err != nil {
		fmt.Fprintf(os.Stderr, "warning: cleanup worktree after merge %s: %v\n", short(id), err)
	}
	if err := completeOperation(db, opID, map[string]string{"status": "merged", "task_id": id}); err != nil {
		return fmt.Errorf("complete operation: %w", err)
	}

	fmt.Printf("Merged task %s\n", short(id))
	return nil
}

func (r *Registry) runTaskPlan(cmd *cobra.Command, args []string) error {
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
		id, err = pickTask(store, "Task", allTasks)
	}
	if err != nil {
		return err
	}
	t, err := store.Get(id)
	if err != nil {
		return fmt.Errorf("get task: %w", err)
	}

	save, _ := cmd.Flags().GetBool("save")
	edit, _ := cmd.Flags().GetBool("edit")
	toolOverride, _ := cmd.Flags().GetString("tool")
	modelOverride, _ := cmd.Flags().GetString("model")

	toolName := toolOverride
	if toolName == "" {
		toolName = t.AssignedTool
	}
	if toolName == "" {
		toolNames := make([]string, 0, len(cfg.Tools))
		for name := range cfg.Tools {
			toolNames = append(toolNames, name)
		}
		sort.Strings(toolNames)
		if len(toolNames) == 0 {
			return fmt.Errorf("no tools configured")
		}
		toolName = toolNames[0]
	}

	toolCfg, ok := cfg.Tools[toolName]
	if !ok {
		return fmt.Errorf("tool %q not found in config", toolName)
	}

	modelName := modelOverride
	if modelName == "" && t.Model != "" {
		modelName = t.Model
	}

	repoDir, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("get working directory: %w", err)
	}

	generator := planpkg.New(toolCfg, repoDir)
	if err := ensureOperationsTable(db); err != nil {
		return fmt.Errorf("ensure operations table: %w", err)
	}
	opID, err := createOperation(db, "plan_generate", id)
	if err != nil {
		return fmt.Errorf("create operation: %w", err)
	}

	fmt.Printf("Generating plan for task %s (op %s)\n", short(id), short(opID))
	var planContent string
	spinDone := make(chan struct{})
	go renderSpinner("Generating plan", spinDone)
	if modelName != "" {
		planContent, err = generator.GenerateWithModel(t.Title, t.Description, modelName)
	} else {
		planContent, err = generator.Generate(t.Title, t.Description)
	}
	close(spinDone)
	fmt.Print("\r")
	if err != nil {
		_ = failOperation(db, opID, err.Error())
		return fmt.Errorf("generate plan: %w", err)
	}
	if err := completeOperation(db, opID, map[string]string{"task_id": id, "plan": planContent}); err != nil {
		return fmt.Errorf("complete operation: %w", err)
	}

	fmt.Println(planContent)

	shouldSave := save || edit
	if shouldSave {
		if err := store.SetPlan(id, planContent); err != nil {
			return fmt.Errorf("save plan: %w", err)
		}
		if save && !edit {
			fmt.Printf("\nSaved plan to task %s\n", short(id))
		}
	}
	if !edit {
		return nil
	}

	editor := strings.TrimSpace(os.Getenv("EDITOR"))
	if editor == "" {
		return fmt.Errorf("EDITOR is not set")
	}

	tmpFile, err := os.CreateTemp("", "orca-plan-*.md")
	if err != nil {
		return fmt.Errorf("create temp file: %w", err)
	}
	tmpPath := tmpFile.Name()
	if _, err := tmpFile.WriteString(planContent); err != nil {
		tmpFile.Close()
		return fmt.Errorf("write temp plan: %w", err)
	}
	if err := tmpFile.Close(); err != nil {
		return fmt.Errorf("close temp plan: %w", err)
	}
	defer os.Remove(tmpPath)

	editCmd := exec.Command("sh", "-c", fmt.Sprintf("%s %q", editor, tmpPath))
	editCmd.Stdin = os.Stdin
	editCmd.Stdout = os.Stdout
	editCmd.Stderr = os.Stderr
	if err := editCmd.Run(); err != nil {
		return fmt.Errorf("open editor: %w", err)
	}

	edited, err := os.ReadFile(tmpPath)
	if err != nil {
		return fmt.Errorf("read edited plan: %w", err)
	}
	if err := store.SetPlan(id, strings.TrimSpace(string(edited))); err != nil {
		return fmt.Errorf("save edited plan: %w", err)
	}

	fmt.Printf("\nSaved edited plan to task %s\n", short(id))
	return nil
}

func (r *Registry) runTaskEvaluate(cmd *cobra.Command, args []string) error {
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
		id, err = pickTask(store, "Task", allTasks)
	}
	if err != nil {
		return err
	}

	t, err := store.Get(id)
	if err != nil {
		return fmt.Errorf("get task: %w", err)
	}

	toolOverride, _ := cmd.Flags().GetString("tool")
	modelOverride, _ := cmd.Flags().GetString("model")
	jsonOutput, _ := cmd.Flags().GetBool("json")

	toolName := toolOverride
	if toolName == "" {
		toolName = t.AssignedTool
	}
	if toolName == "" {
		toolName = cfg.Defaults.Tool
	}
	if toolName == "" {
		toolNames := make([]string, 0, len(cfg.Tools))
		for name := range cfg.Tools {
			toolNames = append(toolNames, name)
		}
		sort.Strings(toolNames)
		if len(toolNames) == 0 {
			return fmt.Errorf("no tools configured")
		}
		toolName = toolNames[0]
	}

	toolCfg, ok := cfg.Tools[toolName]
	if !ok {
		return fmt.Errorf("tool %q not found in config", toolName)
	}

	modelName := modelOverride
	if modelName == "" && t.Model != "" {
		modelName = t.Model
	}

	repoDir, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("get working directory: %w", err)
	}

	evaluator := evaluate.New(toolCfg, repoDir)
	fmt.Println("Evaluating task complexity...")
	done := make(chan struct{})
	go renderSpinner("Evaluating task complexity", done)

	var result *evaluate.EvaluationResult
	if modelName != "" {
		result, err = evaluator.EvaluateWithModel(t.Title, t.Description, modelName)
	} else {
		result, err = evaluator.Evaluate(t.Title, t.Description)
	}
	close(done)
	fmt.Print("\r")
	if err != nil {
		return fmt.Errorf("evaluate task: %w", err)
	}

	if jsonOutput {
		data, err := json.Marshal(result)
		if err != nil {
			return fmt.Errorf("marshal evaluation result: %w", err)
		}
		fmt.Println(string(data))
		return nil
	}

	needsBreakdown := "no"
	if result.NeedsBreakdown {
		needsBreakdown = "yes"
	}
	fmt.Printf("Needs breakdown: %s\n", needsBreakdown)
	fmt.Printf("Confidence: %.2f\n", result.Confidence)
	fmt.Printf("Reasoning: %s\n", result.Reasoning)
	fmt.Printf("Suggested subtasks: %d\n", result.SuggestedSubtaskCount)
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
		id, err = pickTask(store, "Task", allTasks)
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
		taskIDs, err = pickTasks(store, "Failed tasks", failedTasks)
		if err != nil {
			return err
		}
	}

	var reopened int
	var lastReopenedID string
	for _, arg := range taskIDs {
		id, err := resolveTaskID(store, arg)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			continue
		}

		t, err := store.Get(id)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: get task %s: %v\n", short(id), err)
			continue
		}
		if t.Status != "failed" {
			fmt.Fprintf(os.Stderr, "Error: task %s is %q, not %q\n", short(id), t.Status, "failed")
			continue
		}

		if err := store.Update(id, map[string]interface{}{"status": "pending", "sprint_id": nil}); err != nil {
			fmt.Fprintf(os.Stderr, "Error: reopen task %s: %v\n", short(id), err)
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
