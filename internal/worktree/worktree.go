// Package worktree manages git worktree creation, lifecycle, and cleanup for worker isolation.
package worktree

import (
	"bufio"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// WorktreeInfo holds parsed info from `git worktree list --porcelain`.
type WorktreeInfo struct {
	Path   string
	Branch string
	Head   string
}

// WorktreeAge holds worktree info plus its age.
type WorktreeAge struct {
	WorktreeInfo
	TaskID string
	Age    time.Duration
}

// Manager handles git worktree lifecycle for worker isolation.
type Manager struct {
	repoDir     string
	worktreeDir string
}

// NewManager creates a worktree manager rooted at the given repo, storing
// worktrees under worktreeDir.
func NewManager(repoDir, worktreeDir string) *Manager {
	if !filepath.IsAbs(worktreeDir) {
		worktreeDir = filepath.Join(repoDir, worktreeDir)
	}
	return &Manager{
		repoDir:     repoDir,
		worktreeDir: worktreeDir,
	}
}

// Slugify converts a title string into a branch/directory-safe slug.
func Slugify(title string) string {
	s := strings.ToLower(strings.TrimSpace(title))
	var b strings.Builder
	prevDash := true
	for _, r := range s {
		switch {
		case (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9'):
			b.WriteRune(r)
			prevDash = false
		default:
			if !prevDash {
				b.WriteByte('-')
				prevDash = true
			}
		}
	}
	out := strings.TrimRight(b.String(), "-")
	if len(out) > 50 {
		if idx := strings.LastIndex(out[:50], "-"); idx > 10 {
			out = out[:idx]
		} else {
			out = out[:50]
		}
	}
	return out
}

// FormatDirName returns the worktree directory name for a task.
func FormatDirName(taskID, title string) string {
	slug := Slugify(title)
	if slug == "" {
		return "task-" + taskID
	}
	return "task-" + taskID + "--" + slug
}

// FormatBranchName returns the git branch name for a task.
func FormatBranchName(taskID, title string) string {
	return "orca/" + FormatDirName(taskID, title)
}

// ResolveTaskDir finds the actual worktree directory path for a taskID,
// handling both old (task-{id}) and new (task-{id}--{slug}) formats.
func ResolveTaskDir(worktreeDir, taskID string) string {
	if !filepath.IsAbs(worktreeDir) {
		if abs, err := filepath.Abs(worktreeDir); err == nil {
			worktreeDir = abs
		}
	}
	exact := filepath.Join(worktreeDir, "task-"+taskID)
	if _, err := os.Stat(exact); err == nil {
		return exact
	}
	matches, _ := filepath.Glob(filepath.Join(worktreeDir, "task-"+taskID+"--*"))
	if len(matches) == 1 {
		return matches[0]
	}
	return exact
}

// ResolveTaskBranch returns the git branch name for a taskID by
// deriving it from the worktree directory name.
func ResolveTaskBranch(worktreeDir, taskID string) string {
	dir := ResolveTaskDir(worktreeDir, taskID)
	return "orca/" + filepath.Base(dir)
}

// ExtractTaskID extracts the task ID from a worktree dir name or branch name.
// Handles "task-{id}", "task-{id}--{slug}", "orca/task-{id}", "orca/task-{id}--{slug}".
func ExtractTaskID(name string) string {
	name = strings.TrimPrefix(name, "orca/")
	name = strings.TrimPrefix(name, "task-")
	if idx := strings.Index(name, "--"); idx > 0 {
		return name[:idx]
	}
	return name
}

// Create adds a new git worktree for the given task, branched from baseBranch.
// The taskTitle is slugified and appended to the directory and branch names.
// Returns the worktree path and branch name.
func (m *Manager) Create(taskID, baseBranch, taskTitle string) (worktreePath string, branchName string, err error) {
	if err := os.MkdirAll(m.worktreeDir, 0o755); err != nil {
		return "", "", fmt.Errorf("create worktree dir: %w", err)
	}

	branchName = FormatBranchName(taskID, taskTitle)
	worktreePath = filepath.Join(m.worktreeDir, FormatDirName(taskID, taskTitle))

	if _, err := os.Stat(worktreePath); err == nil {
		return "", "", fmt.Errorf("worktree already exists: %s", worktreePath)
	}

	// git worktree add <path> -b <branch> <baseBranch>
	if err := m.gitCmd("worktree", "add", worktreePath, "-b", branchName, baseBranch); err != nil {
		return "", "", fmt.Errorf("git worktree add: %w", err)
	}

	return worktreePath, branchName, nil
}

// Remove deletes a worktree and its associated branch for the given task.
func (m *Manager) Remove(taskID string) error {
	worktreePath := ResolveTaskDir(m.worktreeDir, taskID)
	branchName := "orca/" + filepath.Base(worktreePath)

	if err := m.gitCmd("worktree", "remove", "--force", worktreePath); err != nil {
		// If worktree dir is already gone, just prune stale entries.
		m.gitCmd("worktree", "prune")
	}

	if err := m.gitCmd("branch", "-D", branchName); err != nil {
		// Branch may already be deleted or never existed; ignore.
	}

	return nil
}

// List returns info about all worktrees in the repo.
func (m *Manager) List() ([]WorktreeInfo, error) {
	cmd := exec.Command("git", "worktree", "list", "--porcelain")
	cmd.Dir = m.repoDir

	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("git worktree list: %w", fmtExecErr(err))
	}

	return parsePorcelain(string(out)), nil
}

// ListWithAge returns all orca worktrees with their age.
func (m *Manager) ListWithAge() ([]WorktreeAge, error) {
	entries, err := os.ReadDir(m.worktreeDir)
	if err != nil {
		return nil, err
	}

	var result []WorktreeAge
	for _, entry := range entries {
		if !entry.IsDir() || !strings.HasPrefix(entry.Name(), "task-") {
			continue
		}

		info, err := entry.Info()
		if err != nil {
			continue
		}

		taskID := ExtractTaskID(entry.Name())
		path := filepath.Join(m.worktreeDir, entry.Name())

		result = append(result, WorktreeAge{
			WorktreeInfo: WorktreeInfo{Path: path},
			TaskID:       taskID,
			Age:          time.Since(info.ModTime()),
		})
	}

	sort.Slice(result, func(i, j int) bool {
		return result[i].TaskID < result[j].TaskID
	})

	return result, nil
}

// CleanupStale removes worktrees older than maxAge. Returns removed task IDs and errors.
func (m *Manager) CleanupStale(maxAge time.Duration) (removed []string, errs []error) {
	entries, err := os.ReadDir(m.worktreeDir)
	if err != nil {
		return nil, []error{err}
	}

	for _, entry := range entries {
		if !entry.IsDir() || !strings.HasPrefix(entry.Name(), "task-") {
			continue
		}

		info, err := entry.Info()
		if err != nil {
			continue
		}

		if time.Since(info.ModTime()) < maxAge {
			continue
		}

		taskID := ExtractTaskID(entry.Name())
		if err := m.Remove(taskID); err != nil {
			errs = append(errs, fmt.Errorf("remove %s: %w", taskID, err))
			continue
		}
		removed = append(removed, taskID)
	}

	return removed, errs
}

// DiskUsage returns total bytes used by all worktrees.
func (m *Manager) DiskUsage() (int64, error) {
	var total int64
	err := filepath.WalkDir(m.worktreeDir, func(_ string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}

		info, err := d.Info()
		if err == nil {
			total += info.Size()
		}
		return nil
	})
	return total, err
}

// EnsureIntegrationBranch creates the named branch from HEAD if it doesn't
// already exist. No-op if the branch exists.
func (m *Manager) EnsureIntegrationBranch(branchName string) error {
	// `git branch <name>` fails if branch exists; ignore that specific error.
	cmd := exec.Command("git", "branch", branchName)
	cmd.Dir = m.repoDir

	if out, err := cmd.CombinedOutput(); err != nil {
		// "already exists" is expected and fine.
		if strings.Contains(string(out), "already exists") {
			return nil
		}
		return fmt.Errorf("git branch %s: %s", branchName, strings.TrimSpace(string(out)))
	}
	return nil
}

// gitCmd runs a git command in the repo dir, returning a wrapped error on failure.
func (m *Manager) gitCmd(args ...string) error {
	cmd := exec.Command("git", args...)
	cmd.Dir = m.repoDir

	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("%s: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// fmtExecErr extracts stderr from an exec.ExitError if available.
func fmtExecErr(err error) error {
	if ee, ok := err.(*exec.ExitError); ok && len(ee.Stderr) > 0 {
		return fmt.Errorf("%w: %s", err, strings.TrimSpace(string(ee.Stderr)))
	}
	return err
}

// parsePorcelain parses `git worktree list --porcelain` output into WorktreeInfo slices.
//
// Format:
//
//	worktree /path/to/worktree
//	HEAD abc123
//	branch refs/heads/branch-name
//	<blank line>
func parsePorcelain(output string) []WorktreeInfo {
	var result []WorktreeInfo
	var current WorktreeInfo

	scanner := bufio.NewScanner(strings.NewReader(output))
	for scanner.Scan() {
		line := scanner.Text()

		switch {
		case strings.HasPrefix(line, "worktree "):
			current.Path = strings.TrimPrefix(line, "worktree ")
		case strings.HasPrefix(line, "HEAD "):
			current.Head = strings.TrimPrefix(line, "HEAD ")
		case strings.HasPrefix(line, "branch "):
			ref := strings.TrimPrefix(line, "branch ")
			current.Branch = strings.TrimPrefix(ref, "refs/heads/")
		case line == "":
			if current.Path != "" {
				result = append(result, current)
				current = WorktreeInfo{}
			}
		}
	}
	// Capture last entry if output doesn't end with blank line.
	if current.Path != "" {
		result = append(result, current)
	}

	return result
}
