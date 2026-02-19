// Package integrator handles merging task branches into the integration branch,
// conflict detection/resolution, and running the validation gate.
package integrator

import (
	"context"
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/jasjeetmavi/pod/internal/config"
	"github.com/jasjeetmavi/pod/internal/worker"
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

		// Attempt rebase: checkout task branch, rebase onto integration, retry merge.
		if rebaseErr := i.git("checkout", branch); rebaseErr != nil {
			return fmt.Errorf("merge %s: %w (checkout for rebase failed: %v)", branch, err, rebaseErr)
		}

		if rebaseErr := i.git("rebase", i.integrationBranch); rebaseErr != nil {
			_ = i.git("rebase", "--abort")
			// Return to integration branch.
			_ = i.git("checkout", i.integrationBranch)
			return fmt.Errorf("merge %s: conflict unresolvable after rebase attempt", branch)
		}

		// Rebase succeeded — back to integration and retry merge.
		if err := i.git("checkout", i.integrationBranch); err != nil {
			return fmt.Errorf("checkout %s after rebase: %w", i.integrationBranch, err)
		}

		msg := fmt.Sprintf("pod: merge task-%s (after rebase)", taskID)
		if err := i.git("merge", branch, "--no-ff", "-m", msg); err != nil {
			_ = i.git("merge", "--abort")
			return fmt.Errorf("merge %s after rebase: %w", branch, err)
		}
	}

	return nil
}

// MergeWithRerun tries Merge, and if it fails and rerun config is set,
// re-runs the worker to fix conflicts then retries merge one final time.
func (i *Integrator) MergeWithRerun(taskID string) error {
	err := i.Merge(taskID)
	if err == nil {
		return nil
	}

	if i.worktreeDir == "" || i.toolResolver == nil {
		return err
	}

	toolCfg, resolveErr := i.toolResolver(taskID)
	if resolveErr != nil {
		return fmt.Errorf("%w (tool resolve failed: %v)", err, resolveErr)
	}

	adapter, adapterErr := worker.NewAdapter(toolCfg)
	if adapterErr != nil {
		return fmt.Errorf("%w (create adapter: %v)", err, adapterErr)
	}

	wtPath := filepath.Join(i.worktreeDir, "task-"+taskID)
	prompt := "The previous implementation had merge conflicts after rebasing onto the integration branch. " +
		"Please resolve any issues and ensure the code works correctly. " +
		"The branch has been rebased — review the current state and fix any problems."

	_, execErr := adapter.Execute(context.Background(), taskID, prompt, wtPath)
	if execErr != nil {
		return fmt.Errorf("%w (re-run failed: %v)", err, execErr)
	}

	// Stage and amend the commit in the worktree.
	gitAmend := exec.Command("git", "add", "-A")
	gitAmend.Dir = wtPath
	_ = gitAmend.Run()

	gitCommit := exec.Command("git", "commit", "--amend", "--no-edit")
	gitCommit.Dir = wtPath
	_ = gitCommit.Run()

	// Final merge attempt.
	if finalErr := i.Merge(taskID); finalErr != nil {
		return fmt.Errorf("merge %s failed after re-run: %w", "pod/task-"+taskID, finalErr)
	}

	return nil
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

// MergeBatch processes multiple task IDs in order. Each is merged and validated
// independently — a failure on one does not block the rest.
// Uses MergeWithRerun when rerun config is set, otherwise MergeAndValidate.
func (i *Integrator) MergeBatch(taskIDs []string) (merged []string, failed []string, err error) {
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
