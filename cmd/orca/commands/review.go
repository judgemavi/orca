package commands

import "github.com/spf13/cobra"

func RegisterReview(root *cobra.Command, r *Registry) {
	reviewCmd := &cobra.Command{Use: "review", Short: "Review approved tasks"}
	approveCmd := &cobra.Command{Use: "approve [task-id]", Short: "Approve a task in review", Args: cobra.MaximumNArgs(1), RunE: r.runReviewApprove}
	requestChangesCmd := &cobra.Command{Use: "request-changes [task-id] [feedback]", Short: "Request changes on a task in review", Args: cobra.RangeArgs(0, 2), RunE: r.runReviewRequestChanges}
	reviewCmd.AddCommand(approveCmd, requestChangesCmd)
	root.AddCommand(reviewCmd)
}
