package procutil

import (
	"os/exec"
)

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
