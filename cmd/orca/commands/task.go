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
	taskCmd.AddCommand(addCmd)

	taskCmd.AddCommand(&cobra.Command{Use: "list", Short: "List tasks", RunE: r.runTaskList})

	editCmd := &cobra.Command{Use: "edit [id]", Short: "Edit a task", Args: cobra.MaximumNArgs(1), RunE: r.runTaskEdit}
	editCmd.Flags().String("title", "", "New title")
	editCmd.Flags().String("description", "", "New description")
	editCmd.Flags().String("plan", "", "New implementation plan")
	editCmd.Flags().String("status", "", "New status")
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

	approvePlanCmd := &cobra.Command{
		Use:   "approve-plan [task-id]",
		Short: "Approve a task's plan, moving it to 'planned' status",
		Args:  cobra.MaximumNArgs(1),
		RunE:  r.runTaskApprovePlan,
	}
	taskCmd.AddCommand(approvePlanCmd)

	requestPlanChangesCmd := &cobra.Command{
		Use:   "request-plan-changes [task-id] [feedback]",
		Short: "Request changes to a task's plan and regenerate",
		Args:  cobra.RangeArgs(0, 2),
		RunE:  r.runTaskRequestPlanChanges,
	}
	requestPlanChangesCmd.Flags().String("tool", "", "Tool for regeneration")
	requestPlanChangesCmd.Flags().String("model", "", "Model for regeneration")
	taskCmd.AddCommand(requestPlanChangesCmd)

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
	taskCmd.AddCommand(&cobra.Command{Use: "stop [task-id]", Short: "Stop a running task", Args: cobra.MaximumNArgs(1), RunE: r.runTaskStop})
	taskCmd.AddCommand(&cobra.Command{Use: "resume [task-id]", Short: "Resume a stopped task from session", Args: cobra.MaximumNArgs(1), RunE: r.runTaskResume})
	addDepCmd := &cobra.Command{
		Use:   "add-dep <task-id> <depends-on-id>",
		Short: "Add a dependency to a task",
		Args:  cobra.ExactArgs(2),
		RunE:  r.runTaskAddDep,
	}
	taskCmd.AddCommand(addDepCmd)
	reviewsCmd := &cobra.Command{
		Use:   "reviews [task-id]",
		Short: "List reviews for a task",
		Args:  cobra.MaximumNArgs(1),
		RunE:  r.runTaskReviews,
	}
	taskCmd.AddCommand(reviewsCmd)
	logsCmd := &cobra.Command{Use: "logs [task-id]", Short: "Show interaction logs for a task", Args: cobra.ExactArgs(1), RunE: r.runTaskLogs}
	logsCmd.Flags().String("phase", "", "Phase to inspect (plan, run, review, merge)")
	logsCmd.Flags().Int("attempt", 0, "Attempt number for --phase (defaults to latest)")
	logsCmd.Flags().Bool("raw", false, "Show raw NDJSON content (requires --phase)")
	logsCmd.Flags().BoolP("follow", "f", false, "Follow interaction output if it is still running (requires --phase)")
	logsCmd.Flags().Bool("json", false, "Output as JSON")
	taskCmd.AddCommand(logsCmd)

	root.AddCommand(taskCmd)
}
