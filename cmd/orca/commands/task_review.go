package commands

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/charmbracelet/huh"
	"github.com/jasjeetmavi/orca/internal/driver"
	"github.com/jasjeetmavi/orca/internal/executor"
	"github.com/jasjeetmavi/orca/internal/integrator"
	"github.com/jasjeetmavi/orca/internal/interaction"
	"github.com/jasjeetmavi/orca/internal/review"
	"github.com/jasjeetmavi/orca/internal/task"
	"github.com/spf13/cobra"
)

func (r *Registry) runTaskMerge(cmd *cobra.Command, args []string) error {
	db, cfg, executor, err := r.loadRuntimeOrErr()
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
		id, err = pickTask(store, "Approved task", statusFilter("approved"))
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

	interactions := interaction.NewStore(db, ".orca/interactions")
	taskRef := id
	writer, err := interactions.Begin(&taskRef, "merge", "orca")
	if err != nil {
		return fmt.Errorf("begin merge interaction: %w", err)
	}
	defer writer.Close()

	repoDir, _ := os.Getwd()
	ig := integrator.New(repoDir, cfg.Project.IntegrationBranch, cfg.Validation.Commands, interactions)
	if auto {
		ig.SetRerunConfig(cfg.Project.WorktreeDir, func(taskID string) (string, driver.Driver, string, time.Duration, error) {
			if _, err := store.Get(taskID); err != nil {
				return "", nil, "", 0, err
			}
			toolName, d, err := cfg.ResolveToolForPhase("merge", "")
			if err != nil {
				return "", nil, "", 0, err
			}
			model := cfg.ResolveModelForPhase("merge", "", d)
			return toolName, d, model, 10 * time.Minute, nil
		})
	}

	fmt.Printf("Merging task %s\n", short(id))
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
		_ = interactions.Finish(writer.ID(), "failed", interaction.WithError(mergeErr.Error()))
		if strings.Contains(strings.ToLower(mergeErr.Error()), "conflict") {
			worktreePath := filepath.Join(cfg.Project.WorktreeDir, "task-"+id)
			return fmt.Errorf("merge conflict for task %s (worktree: %s): %w", short(id), worktreePath, mergeErr)
		}
		return fmt.Errorf("merge task %s: %w", short(id), mergeErr)
	}

	if err := store.Update(id, map[string]interface{}{"status": "merged"}); err != nil {
		_ = interactions.Finish(writer.ID(), "failed", interaction.WithError(err.Error()))
		return fmt.Errorf("set merged status: %w", err)
	}
	if err := executor.Worktrees().Remove(id); err != nil {
		warnf("cleanup worktree after merge %s: %v", short(id), err)
	}
	if err := interactions.Finish(writer.ID(), "completed"); err != nil {
		return fmt.Errorf("finish merge interaction: %w", err)
	}

	fmt.Printf("Merged task %s\n", short(id))

	return nil
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

	if _, err := store.AddReview(taskID, feedback, ""); err != nil {
		return fmt.Errorf("add review for task %s: %w", short(taskID), err)
	}
	if err := store.Update(taskID, map[string]interface{}{"status": "running"}); err != nil {
		return fmt.Errorf("update status for task %s: %w", short(taskID), err)
	}

	runtimeDB, _, taskExecutor, err := r.loadRuntimeOrErr()
	if err != nil {
		return err
	}
	defer runtimeDB.Close()

	fmt.Printf("Feedback stored. Re-running task %s...\n", short(taskID))
	toolOverride, _ := cmd.Flags().GetString("tool")
	modelOverride, _ := cmd.Flags().GetString("model")
	runCtx := cmd.Context()
	if runCtx == nil {
		runCtx = context.Background()
	}
	if err := taskExecutor.RunSingleWithOpts(runCtx, taskID, executor.RunOpts{
		ToolOverride:  strings.TrimSpace(toolOverride),
		ModelOverride: strings.TrimSpace(modelOverride),
	}); err != nil {
		return fmt.Errorf("re-run task %s: %w", short(taskID), err)
	}

	updated, err := store.Get(taskID)
	if err != nil {
		return fmt.Errorf("get task %s after re-run: %w", short(taskID), err)
	}
	fmt.Printf("Task %s re-run finished with status: %s\n", short(taskID), updated.Status)
	return nil
}

func (r *Registry) runReviewAI(cmd *cobra.Command, args []string) error {
	db, cfg, _, err := r.loadRuntimeOrErr()
	if err != nil {
		return err
	}
	defer db.Close()

	store := task.NewStore(db)

	var taskID string
	if len(args) > 0 {
		taskID, err = resolveTaskID(store, args[0])
	} else {
		taskID, err = pickTask(store, "AI review task", statusFilter("review"))
	}
	if err != nil {
		return err
	}

	tk, err := store.Get(taskID)
	if err != nil {
		return fmt.Errorf("get task %s: %w", short(taskID), err)
	}
	if tk.Status != "review" {
		return fmt.Errorf("task %s is %q, expected %q", short(taskID), tk.Status, "review")
	}

	toolFlag, _ := cmd.Flags().GetString("tool")
	modelFlag, _ := cmd.Flags().GetString("model")
	promptFlag, _ := cmd.Flags().GetString("prompt")

	toolName, d, err := cfg.ResolveToolForPhase("review", strings.TrimSpace(toolFlag))
	if err != nil {
		return err
	}
	model := cfg.ResolveModelForPhase("review", strings.TrimSpace(modelFlag), d)

	interactions := interaction.NewStore(db, ".orca/interactions")
	runInteractions, err := interactions.ListByPhase(taskID, "run")
	if err != nil {
		return fmt.Errorf("list run interactions for task %s: %w", short(taskID), err)
	}

	diff := ""
	for _, in := range runInteractions {
		if in.Status == "completed" && strings.TrimSpace(in.Diff) != "" {
			diff = in.Diff
			break
		}
	}
	if strings.TrimSpace(diff) == "" {
		return fmt.Errorf("no completed run interaction with diff found")
	}

	repoDir, _ := os.Getwd()
	reviewer := review.New(toolName, d, model, 10*time.Minute, repoDir, interactions)
	result, err := reviewer.Review(taskID, tk.Title, tk.Description, diff, strings.TrimSpace(promptFlag))
	if err != nil {
		return fmt.Errorf("run ai review for task %s: %w", short(taskID), err)
	}

	status := "Changes Suggested"
	if result.Approved {
		status = "Approved"
	}
	fmt.Printf("AI Review: %s\n", short(taskID))
	fmt.Printf("Status: %s\n", status)
	fmt.Printf("Tool: %s\n\n", result.Tool)
	fmt.Println("Feedback:")
	fmt.Println(strings.TrimSpace(result.Feedback))

	return nil
}

func (r *Registry) runTaskReviews(cmd *cobra.Command, args []string) error {
	db, store, err := r.openStoreOrErr()
	if err != nil {
		return err
	}
	defer db.Close()

	var taskID string
	if len(args) > 0 {
		taskID, err = resolveTaskID(store, args[0])
		if err != nil {
			return err
		}
	} else {
		taskID, err = pickTask(store, "Task reviews", statusFilter())
		if err != nil {
			return err
		}
	}

	reviews, err := store.ListReviews(taskID)
	if err != nil {
		return fmt.Errorf("list reviews for task %s: %w", short(taskID), err)
	}
	if len(reviews) == 0 {
		fmt.Printf("No reviews found for task %s.\n", short(taskID))
		return nil
	}

	tw := tabwriter.NewWriter(os.Stdout, 0, 4, 2, ' ', 0)
	fmt.Fprintln(tw, "ID\tSTATUS\tFEEDBACK\tINTERACTION\tCREATED")
	for _, rev := range reviews {
		interactionID := "-"
		if rev.InteractionID != nil && strings.TrimSpace(*rev.InteractionID) != "" {
			interactionID = short(*rev.InteractionID)
		}
		feedback := strings.Join(strings.Fields(rev.Feedback), " ")
		fmt.Fprintf(
			tw,
			"%s\t%s\t%s\t%s\t%s\n",
			short(rev.ID),
			rev.Status,
			feedback,
			interactionID,
			rev.CreatedAt.Local().Format("2006-01-02 15:04:05"),
		)
	}
	return tw.Flush()
}
