package task

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// OrphanedTask represents a task that was running when Orca exited.
type OrphanedTask struct {
	TaskID       string
	WorktreePath string
	HasCommits   bool // true if worktree has commits beyond the base branch
}

// RecoverOrphans finds tasks in "running" status and determines their state.
// Call this on startup before accepting new commands.
func (s *Store) RecoverOrphans(worktreeDir, integrationBranch string) ([]OrphanedTask, error) {
	tasks, err := s.ListByStatus("running")
	if err != nil {
		return nil, err
	}

	var orphans []OrphanedTask
	for _, t := range tasks {
		wtPath := filepath.Join(worktreeDir, "task-"+t.ID)
		hasCommits := false

		if _, err := os.Stat(wtPath); err == nil {
			cmd := exec.Command("git", "log", integrationBranch+"..HEAD", "--oneline")
			cmd.Dir = wtPath
			out, _ := cmd.Output()
			hasCommits = len(strings.TrimSpace(string(out))) > 0
		}

		orphans = append(orphans, OrphanedTask{
			TaskID:       t.ID,
			WorktreePath: wtPath,
			HasCommits:   hasCommits,
		})
	}
	return orphans, nil
}

// ResolveOrphan transitions an orphaned task to an appropriate state.
// - HasCommits=true -> move to "review" (work was done, needs review)
// - HasCommits=false -> move to "failed" (no work completed)
func (s *Store) ResolveOrphan(taskID string, hasCommits bool) error {
	if hasCommits {
		return s.Update(taskID, map[string]interface{}{"status": "review"})
	}
	return s.Update(taskID, map[string]interface{}{"status": "failed"})
}
