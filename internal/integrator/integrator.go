// Package integrator handles merging task branches into the integration branch,
// conflict detection/resolution, and running the validation gate.
package integrator

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"

	"github.com/jasjeetmavi/pod/internal/config"
	"github.com/jasjeetmavi/pod/internal/worker"
	"github.com/jasjeetmavi/pod/prompts"
)

// Integrator merges task worktree branches into an integration branch
// and runs validation commands to ensure the result is clean.
type Integrator struct {
	repoDir           string
	integrationBranch string
	validationCmds    []string

	// For auto-rebase re-run support.
	worktreeDir  string
	toolResolver func(taskID string) (config.ToolConfig, error)
}

// New creates an Integrator.
func New(repoDir, integrationBranch string, validationCmds []string) *Integrator {
	return &Integrator{
		repoDir:           repoDir,
		integrationBranch: integrationBranch,
		validationCmds:    validationCmds,
	}
}

// SetRerunConfig configures the integrator for auto-rebase re-run support.
func (i *Integrator) SetRerunConfig(worktreeDir string, resolver func(string) (config.ToolConfig, error)) {
	i.worktreeDir = worktreeDir
	i.toolResolver = resolver
}

// Merge merges the task branch into the integration branch using --no-ff.
// On conflict it aborts the merge, attempts a rebase, and retries.
func (i *Integrator) Merge(taskID string) error {
	branch := "pod/task-" + taskID

	if err := i.git("checkout", i.integrationBranch); err != nil {
		return fmt.Errorf("checkout %s: %w", i.integrationBranch, err)
	}

	msg := fmt.Sprintf("pod: merge task-%s", taskID)
	if err := i.git("merge", branch, "--no-ff", "-m", msg); err != nil {
		_ = i.git("merge", "--abort")

		// Attempt rebase inside the worktree (where the branch is already checked out).
		wtPath := filepath.Join(i.worktreeDir, "task-"+taskID)
		_, wtStatErr := os.Stat(wtPath)
		if i.worktreeDir != "" && wtStatErr == nil {
			rebaseCmd := exec.Command("git", "rebase", i.integrationBranch)
			rebaseCmd.Dir = wtPath
			if out, rebaseErr := rebaseCmd.CombinedOutput(); rebaseErr != nil {
				abortCmd := exec.Command("git", "rebase", "--abort")
				abortCmd.Dir = wtPath
				_ = abortCmd.Run()
				return fmt.Errorf("merge %s: conflict unresolvable after rebase attempt: %s", branch, strings.TrimSpace(string(out)))
			}

			msg := fmt.Sprintf("pod: merge task-%s (after rebase)", taskID)
			if err := i.git("merge", branch, "--no-ff", "-m", msg); err != nil {
				_ = i.git("merge", "--abort")
				return fmt.Errorf("merge %s after rebase: %w", branch, err)
			}
		} else {
			// No worktree — fallback to checkout/rebase in the main repository.
			if rebaseErr := i.git("checkout", branch); rebaseErr != nil {
				return fmt.Errorf("merge %s: %w (checkout for rebase failed: %v)", branch, err, rebaseErr)
			}
			if rebaseErr := i.git("rebase", i.integrationBranch); rebaseErr != nil {
				_ = i.git("rebase", "--abort")
				_ = i.git("checkout", i.integrationBranch)
				return fmt.Errorf("merge %s: conflict unresolvable after rebase attempt", branch)
			}
			if err := i.git("checkout", i.integrationBranch); err != nil {
				return fmt.Errorf("checkout %s after rebase: %w", i.integrationBranch, err)
			}

			msg := fmt.Sprintf("pod: merge task-%s (after rebase)", taskID)
			if err := i.git("merge", branch, "--no-ff", "-m", msg); err != nil {
				_ = i.git("merge", "--abort")
				return fmt.Errorf("merge %s after rebase: %w", branch, err)
			}
		}
	}

	return nil
}

// MergeWithRerun tries Merge, and if it fails with a conflict, starts a rebase
// in the worktree leaving conflict markers in place, runs a tool to resolve them,
// then continues the rebase and retries the merge.
func (i *Integrator) MergeWithRerun(taskID string) error {
	// Try clean merge first.
	if err := i.Merge(taskID); err == nil {
		return nil
	}

	if i.worktreeDir == "" || i.toolResolver == nil {
		return fmt.Errorf("merge conflict for task-%s and no rerun config set", taskID)
	}

	wtPath := filepath.Join(i.worktreeDir, "task-"+taskID)
	branch := "pod/task-" + taskID

	// Ensure we're on integration branch in the main repo.
	_ = i.git("checkout", i.integrationBranch)

	// Start rebase in the worktree — do NOT abort on conflict.
	// This leaves conflict markers in the files for the tool to resolve.
	rebaseCmd := exec.Command("git", "rebase", i.integrationBranch)
	rebaseCmd.Dir = wtPath
	rebaseCmd.CombinedOutput() // ignore error — conflict is expected

	// Resolve tool.
	toolCfg, err := i.toolResolver(taskID)
	if err != nil {
		i.abortRebaseInWorktree(wtPath)
		return fmt.Errorf("resolve tool for conflict resolution: %w", err)
	}

	adapter, err := worker.NewAdapter(toolCfg)
	if err != nil {
		i.abortRebaseInWorktree(wtPath)
		return fmt.Errorf("create adapter for conflict resolution: %w", err)
	}

	prompt := prompts.ConflictResolve

	if _, execErr := adapter.Execute(context.Background(), taskID, prompt, wtPath); execErr != nil {
		i.abortRebaseInWorktree(wtPath)
		return fmt.Errorf("tool failed to resolve conflicts: %w", execErr)
	}

	// Stage resolved files and continue rebase.
	addCmd := exec.Command("git", "add", "-A")
	addCmd.Dir = wtPath
	if out, err := addCmd.CombinedOutput(); err != nil {
		i.abortRebaseInWorktree(wtPath)
		return fmt.Errorf("git add after resolve: %s", strings.TrimSpace(string(out)))
	}

	// Loop: rebase --continue may hit more commits with conflicts.
	for attempt := 0; attempt < 10; attempt++ {
		contCmd := exec.Command("git", "-c", "core.editor=true", "rebase", "--continue")
		contCmd.Dir = wtPath
		out, contErr := contCmd.CombinedOutput()
		if contErr == nil {
			// Rebase complete — do the final merge.
			break
		}

		outStr := string(out)
		if !strings.Contains(strings.ToLower(outStr), "conflict") {
			// Non-conflict error during rebase continue.
			i.abortRebaseInWorktree(wtPath)
			return fmt.Errorf("rebase --continue failed: %s", strings.TrimSpace(outStr))
		}

		// Another commit has conflicts — run tool again.
		if _, execErr := adapter.Execute(context.Background(), taskID, prompt, wtPath); execErr != nil {
			i.abortRebaseInWorktree(wtPath)
			return fmt.Errorf("tool failed to resolve conflicts (attempt %d): %w", attempt+2, execErr)
		}

		addCmd2 := exec.Command("git", "add", "-A")
		addCmd2.Dir = wtPath
		_ = addCmd2.Run()
	}

	// Final merge — should be clean now.
	msg := fmt.Sprintf("pod: merge task-%s (after rebase)", taskID)
	if err := i.git("merge", branch, "--no-ff", "-m", msg); err != nil {
		_ = i.git("merge", "--abort")
		return fmt.Errorf("merge %s failed after conflict resolution: %w", branch, err)
	}

	return nil
}

// abortRebaseInWorktree safely aborts a rebase in progress inside a worktree.
func (i *Integrator) abortRebaseInWorktree(wtPath string) {
	cmd := exec.Command("git", "rebase", "--abort")
	cmd.Dir = wtPath
	_ = cmd.Run()
}

// Validate runs each validation command sequentially. Returns on first failure.
func (i *Integrator) Validate() error {
	for _, cmdStr := range i.validationCmds {
		cmd := exec.Command("sh", "-c", cmdStr)
		cmd.Dir = i.repoDir
		out, err := cmd.CombinedOutput()
		if err != nil {
			return fmt.Errorf("validation %q failed: %s", cmdStr, strings.TrimSpace(string(out)))
		}
	}
	return nil
}

// MergeAndValidate merges a task branch then validates. If validation fails,
// reverts the merge commit to keep the integration branch clean.
func (i *Integrator) MergeAndValidate(taskID string) error {
	if err := i.Merge(taskID); err != nil {
		return err
	}

	if err := i.Validate(); err != nil {
		// Revert the merge to keep integration branch clean.
		// -m 1 is needed because --no-ff creates a merge commit.
		_ = i.git("revert", "-m", "1", "HEAD", "--no-edit")
		return fmt.Errorf("task-%s merged but validation failed (reverted): %w", taskID, err)
	}

	return nil
}

// diffLineCount returns the number of lines in a task's diff against the integration branch.
// Returns 0 on error (treat errored tasks as smallest — try them first to fail fast).
func (i *Integrator) diffLineCount(taskID string) int {
	branch := "pod/task-" + taskID
	cmd := exec.Command("git", "diff", "--stat", i.integrationBranch+".."+branch)
	cmd.Dir = i.repoDir
	out, err := cmd.Output()
	if err != nil {
		return 0
	}
	return strings.Count(string(out), "\n")
}

// MergeBatch processes multiple task IDs in order. Each is merged and validated
// independently — a failure on one does not block the rest.
// Uses MergeWithRerun when rerun config is set, otherwise MergeAndValidate.
func (i *Integrator) MergeBatch(taskIDs []string) (merged []string, failed []string, err error) {
	// Sort by diff size — smallest first to minimize conflict surface.
	sort.Slice(taskIDs, func(a, b int) bool {
		return i.diffLineCount(taskIDs[a]) < i.diffLineCount(taskIDs[b])
	})

	useRerun := i.worktreeDir != "" && i.toolResolver != nil
	for _, id := range taskIDs {
		var mergeErr error
		if useRerun {
			mergeErr = i.MergeWithRerun(id)
			if mergeErr == nil {
				mergeErr = i.Validate()
				if mergeErr != nil {
					_ = i.git("revert", "HEAD", "--no-edit")
				}
			}
		} else {
			mergeErr = i.MergeAndValidate(id)
		}
		if mergeErr != nil {
			failed = append(failed, id)
		} else {
			merged = append(merged, id)
		}
	}
	return merged, failed, nil
}

// git runs a git command in the repo dir, returning a wrapped error with stderr on failure.
func (i *Integrator) git(args ...string) error {
	cmd := exec.Command("git", args...)
	cmd.Dir = i.repoDir
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}
