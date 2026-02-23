package commands

import (
	"context"
	"fmt"
	"strings"

	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"
)

func RegisterReview(root *cobra.Command, r *Registry) {
	reviewCmd := &cobra.Command{Use: "review", Short: "Review approved tasks"}
	approveCmd := &cobra.Command{Use: "approve [task-id]", Short: "Approve a task in review", Args: cobra.MaximumNArgs(1), RunE: r.runReviewApprove}
	requestChangesCmd := &cobra.Command{Use: "request-changes [task-id] [feedback]", Short: "Request changes on a task in review", Args: cobra.RangeArgs(0, 2), RunE: r.runReviewRequestChanges}
	reviewCmd.AddCommand(approveCmd, requestChangesCmd)
	root.AddCommand(reviewCmd)
}

func (r *Registry) runReviewApprove(cmd *cobra.Command, args []string) error {
	db, store, err := r.openStoreOrErr()
	if err != nil {
		return err
	}
	defer db.Close()

	var taskID string
	if len(args) > 0 {
		taskID, err = store.ResolveID(args[0])
		if err != nil {
			return fmt.Errorf("resolve %q: %w", args[0], err)
		}
	} else {
		taskID, err = pickTask(store, "Approve task", statusFilter("review"))
		if err != nil {
			return err
		}
	}

	tk, err := store.Get(taskID)
	if err != nil {
		return fmt.Errorf("get task %s: %w", short(taskID), err)
	}
	if tk.Status != "review" {
		return fmt.Errorf("task %s is %q, expected %q", short(taskID), tk.Status, "review")
	}

	if err := store.Update(taskID, map[string]interface{}{"status": "approved"}); err != nil {
		return fmt.Errorf("approve task %s: %w", short(taskID), err)
	}

	fmt.Printf("Task %s approved.\n", short(taskID))
	return nil
}

func (r *Registry) runReviewRequestChanges(cmd *cobra.Command, args []string) error {
	db, store, err := r.openStoreOrErr()
	if err != nil {
		return err
	}
	defer db.Close()

	var (
		taskID   string
		feedback string
	)
	switch len(args) {
	case 0:
		taskID, err = pickTask(store, "Request changes", statusFilter("review"))
		if err != nil {
			return err
		}
		if err := huh.NewText().Title("Feedback").Value(&feedback).Run(); err != nil {
			return err
		}
	case 1:
		taskID, err = store.ResolveID(args[0])
		if err != nil {
			return fmt.Errorf("resolve %q: %w", args[0], err)
		}
		if err := huh.NewText().Title("Feedback").Value(&feedback).Run(); err != nil {
			return err
		}
	default:
		taskID, err = store.ResolveID(args[0])
		if err != nil {
			return fmt.Errorf("resolve %q: %w", args[0], err)
		}
		feedback = args[1]
	}

	tk, err := store.Get(taskID)
	if err != nil {
		return fmt.Errorf("get task %s: %w", short(taskID), err)
	}
	if tk.Status != "review" {
		return fmt.Errorf("task %s is %q, expected %q", short(taskID), tk.Status, "review")
	}

	feedback = strings.TrimSpace(feedback)
	if feedback == "" {
		return fmt.Errorf("feedback cannot be empty")
	}

	if _, err := store.AddReview(taskID, feedback); err != nil {
		return fmt.Errorf("add review for task %s: %w", short(taskID), err)
	}
	if err := store.Update(taskID, map[string]interface{}{"status": "running"}); err != nil {
		return fmt.Errorf("update status for task %s: %w", short(taskID), err)
	}

	runtimeDB, _, _, executor, err := r.loadRuntimeOrErr()
	if err != nil {
		return err
	}
	defer runtimeDB.Close()

	fmt.Printf("Feedback stored. Re-running task %s...\n", short(taskID))
	runCtx := cmd.Context()
	if runCtx == nil {
		runCtx = context.Background()
	}
	if err := executor.RunSingle(runCtx, taskID); err != nil {
		return fmt.Errorf("re-run task %s: %w", short(taskID), err)
	}

	updated, err := store.Get(taskID)
	if err != nil {
		return fmt.Errorf("get task %s after re-run: %w", short(taskID), err)
	}
	fmt.Printf("Task %s re-run finished with status: %s\n", short(taskID), updated.Status)
	return nil
}
