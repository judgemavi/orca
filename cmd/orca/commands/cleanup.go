package commands

import (
	"fmt"
	"os"
	"strings"

	"github.com/charmbracelet/huh"
	"github.com/jasjeetmavi/orca/internal/task"
	"github.com/jasjeetmavi/orca/internal/worktree"
	"github.com/spf13/cobra"
)

func newCleanupCmd(r *Registry) *cobra.Command {
	cleanupCmd := &cobra.Command{Use: "cleanup", Short: "Remove stale worktrees", RunE: r.runCleanup}
	cleanupCmd.Flags().Bool("dry-run", false, "Show what would be removed without removing")
	return cleanupCmd
}

func (r *Registry) runCleanup(cmd *cobra.Command, args []string) error {
	db, _, _, executor, err := r.loadRuntimeOrErr()
	if err != nil {
		return err
	}
	defer db.Close()

	dryRun, _ := cmd.Flags().GetBool("dry-run")
	store := task.NewStore(db)
	wm := executor.Worktrees()

	worktreeList, err := wm.List()
	if err != nil {
		return fmt.Errorf("list worktrees: %w", err)
	}

	type staleEntry struct {
		taskID string
		branch string
		reason string
	}
	var stale []staleEntry
	for _, wt := range worktreeList {
		if wt.Branch == "main" || wt.Branch == "master" || wt.Branch == "" {
			if wt.Branch == "" {
				fmt.Fprintf(os.Stderr, "warning: skipping worktree with no branch: %s\n", wt.Path)
			}
			continue
		}
		if wt.Branch == "orca/integration" || !strings.HasPrefix(wt.Branch, "orca/task-") {
			continue
		}

		taskID := worktree.ExtractTaskID(wt.Branch)
		t, err := store.Get(taskID)
		if err != nil {
			stale = append(stale, staleEntry{taskID: taskID, branch: wt.Branch, reason: "orphan"})
			continue
		}
		if t.Status == "approved" || t.Status == "failed" {
			stale = append(stale, staleEntry{taskID: taskID, branch: wt.Branch, reason: t.Status})
		}
	}

	if len(stale) == 0 {
		fmt.Println("No stale worktrees found.")
		return nil
	}
	for _, s := range stale {
		fmt.Printf("  %s  task-%s  (%s)\n", s.branch, short(s.taskID), s.reason)
	}

	if dryRun {
		fmt.Printf("\nDry run: would remove %d worktrees\n", len(stale))
		return nil
	}

	confirm := false
	if err := huh.NewConfirm().
		Title(fmt.Sprintf("Remove %d stale worktrees?", len(stale))).
		Affirmative("Yes").
		Negative("No").
		Value(&confirm).Run(); err != nil {
		return err
	}
	if !confirm {
		return nil
	}

	if err := ensureOperationsTable(db); err != nil {
		return fmt.Errorf("ensure operations table: %w", err)
	}
	opID, err := createOperation(db, "cleanup", "")
	if err != nil {
		return fmt.Errorf("create operation: %w", err)
	}
	fmt.Printf("cleanup.started operation=%s\n", short(opID))

	var removed int
	for _, s := range stale {
		if err := wm.Remove(s.taskID); err != nil {
			fmt.Fprintf(os.Stderr, "warning: remove %s: %v\n", s.branch, err)
			fmt.Printf("cleanup.progress branch=%s status=failed\n", s.branch)
			continue
		}
		removed++
		fmt.Printf("cleanup.progress branch=%s status=removed\n", s.branch)
	}
	if err := completeOperation(db, opID, map[string]interface{}{"removed": removed}); err != nil {
		return fmt.Errorf("complete operation: %w", err)
	}
	fmt.Printf("cleanup.completed operation=%s removed=%d\n", short(opID), removed)
	fmt.Printf("\nRemoved %d worktrees\n", removed)
	return nil
}
