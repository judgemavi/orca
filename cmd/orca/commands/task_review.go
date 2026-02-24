package commands

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/charmbracelet/huh"
	"github.com/jasjeetmavi/orca/internal/config"
	"github.com/jasjeetmavi/orca/internal/integrator"
	"github.com/jasjeetmavi/orca/internal/ops"
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

	if err := ops.WithOperation(db, "merge", id, func() error {
		repoDir, _ := os.Getwd()
		ig := integrator.New(repoDir, cfg.Project.IntegrationBranch, cfg.Validation.Commands)
		if auto {
			ig.SetRerunConfig(cfg.Project.WorktreeDir, func(taskID string) (config.ToolConfig, error) {
				taskRow, err := store.Get(taskID)
				if err != nil {
					return config.ToolConfig{}, err
				}
				_, tc, err := cfg.ResolveToolForPhase(taskRow, "merge", "")
				if err != nil {
					return config.ToolConfig{}, err
				}
				return tc, nil
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
			if strings.Contains(strings.ToLower(mergeErr.Error()), "conflict") {
				worktreePath := filepath.Join(cfg.Project.WorktreeDir, "task-"+id)
				return fmt.Errorf("merge conflict for task %s (worktree: %s): %w", short(id), worktreePath, mergeErr)
			}
			return fmt.Errorf("merge task %s: %w", short(id), mergeErr)
		}

		if err := store.Update(id, map[string]interface{}{"status": "merged"}); err != nil {
			return fmt.Errorf("set merged status: %w", err)
		}
		if err := executor.Worktrees().Remove(id); err != nil {
			warnf("cleanup worktree after merge %s: %v", short(id), err)
		}

		fmt.Printf("Merged task %s\n", short(id))
		return nil
	}); err != nil {
		return err
	}

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

	if _, err := store.AddReview(taskID, feedback); err != nil {
		return fmt.Errorf("add review for task %s: %w", short(taskID), err)
	}
	if err := store.Update(taskID, map[string]interface{}{"status": "running"}); err != nil {
		return fmt.Errorf("update status for task %s: %w", short(taskID), err)
	}

	runtimeDB, _, executor, err := r.loadRuntimeOrErr()
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
