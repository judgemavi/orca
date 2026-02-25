package commands

import "github.com/spf13/cobra"

func RegisterReview(root *cobra.Command, r *Registry) {
	reviewCmd := &cobra.Command{Use: "review", Short: "Review approved tasks"}
	approveCmd := &cobra.Command{Use: "approve [task-id]", Short: "Approve a task in review", Args: cobra.MaximumNArgs(1), RunE: r.runReviewApprove}
	requestChangesCmd := &cobra.Command{Use: "request-changes [task-id] [feedback]", Short: "Request changes on a task in review", Args: cobra.RangeArgs(0, 2), RunE: r.runReviewRequestChanges}
	requestChangesCmd.Flags().String("tool", "", "Tool to use for re-run")
	requestChangesCmd.Flags().String("model", "", "Model to use for re-run")
	aiCmd := &cobra.Command{
		Use:   "ai [task-id]",
		Short: "Run AI code review on a task's implementation",
		Args:  cobra.MaximumNArgs(1),
		RunE:  r.runReviewAI,
	}
	aiCmd.Flags().String("tool", "", "Tool override for review")
	aiCmd.Flags().String("model", "", "Model override for review")
	aiCmd.Flags().String("prompt", "", "Custom instructions for the reviewer")
	reviewCmd.AddCommand(approveCmd, requestChangesCmd, aiCmd)
	root.AddCommand(reviewCmd)
}
