package procutil

import (
	"os"
	"os/exec"
	"path/filepath"
)

// LoadContextFromWorktree returns .orca/context.md from worktree, or empty string.
func LoadContextFromWorktree(worktreePath string) string {
	data, err := os.ReadFile(filepath.Join(worktreePath, ".orca", "context.md"))
	if err != nil {
		return ""
	}
	return string(data)
}

// GitOutput runs a git command in dir and returns stdout.
func GitOutput(dir string, args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return string(out), nil
}
