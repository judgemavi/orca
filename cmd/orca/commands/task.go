package commands

import "github.com/spf13/cobra"

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
