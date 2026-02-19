// Package worker spawns CLI tool processes (headless/interactive), captures output, and handles timeouts.
package worker

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/jasjeetmavi/pod/internal/config"
)

// Worker executes tasks via either headless or interactive adapter modes.
type Worker interface {
	Execute(ctx context.Context, taskID, prompt, worktreePath string) (*Result, error)
	Cancel()
	SetCmdCallback(func(*exec.Cmd))
}

// Result holds the output of a completed worker execution.
type Result struct {
	TaskID       string
	ExitCode     int
	Stdout       string
	Stderr       string
	Duration     time.Duration
	Diff         string
	FilesChanged []string
}

// Adapter wraps a CLI tool binary for headless execution.
type Adapter struct {
	Binary  string
	Args    []string
	Timeout time.Duration
	// CmdCallback, if set, is called with the exec.Cmd right before it's started.
	// Use this to register the process for external tracking/cancellation.
	CmdCallback func(*exec.Cmd)
}

// NewAdapter creates an Adapter from a ToolConfig.
func NewAdapter(toolCfg config.ToolConfig) (*Adapter, error) {
	timeout, err := time.ParseDuration(toolCfg.Timeout)
	if err != nil {
		return nil, fmt.Errorf("parse timeout %q: %w", toolCfg.Timeout, err)
	}

	return &Adapter{
		Binary:  toolCfg.Binary,
		Args:    toolCfg.HeadlessArgs,
		Timeout: timeout,
	}, nil
}

// NewWorker creates a worker adapter based on configured tool mode.
func NewWorker(toolCfg config.ToolConfig) (Worker, error) {
	if strings.EqualFold(toolCfg.Mode, "interactive") && len(toolCfg.InteractiveArgs) > 0 {
		return NewInteractiveAdapter(toolCfg)
	}
	return NewAdapter(toolCfg)
}

// Execute runs the CLI tool headlessly with the given prompt in the specified worktree.
// The provided context is used as the parent for the timeout context, allowing external cancellation.
func (a *Adapter) Execute(ctx context.Context, taskID, prompt, worktreePath string) (*Result, error) {
	ctx, cancel := context.WithTimeout(ctx, a.Timeout)
	defer cancel()

	// Replace {{prompt}} placeholder in args.
	args := make([]string, len(a.Args))
	for i, arg := range a.Args {
		args[i] = strings.ReplaceAll(arg, "{{prompt}}", prompt)
	}

	cmd := exec.CommandContext(ctx, a.Binary, args...)
	cmd.Dir = worktreePath

	// Clear env vars that prevent nesting (e.g. CLAUDECODE).
	cmd.Env = filteredEnv()

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if a.CmdCallback != nil {
		a.CmdCallback(cmd)
	}

	start := time.Now()
	runErr := cmd.Run()
	duration := time.Since(start)

	result := &Result{
		TaskID:   taskID,
		Stdout:   stdout.String(),
		Stderr:   stderr.String(),
		Duration: duration,
	}

	if ctx.Err() == context.DeadlineExceeded {
		result.ExitCode = -1
		result.Stderr = result.Stderr + "\npod: process killed after timeout (" + a.Timeout.String() + ")"
	} else if ctx.Err() == context.Canceled {
		result.ExitCode = -1
		result.Stderr = result.Stderr + "\npod: process cancelled"
	} else if runErr != nil {
		if ee, ok := runErr.(*exec.ExitError); ok {
			result.ExitCode = ee.ExitCode()
		} else {
			return nil, fmt.Errorf("exec %s: %w", a.Binary, runErr)
		}
	}

	// Stage all changes (including new files) and commit.
	_, _ = gitOutput(worktreePath, "add", "-A")
	_, _ = gitOutput(worktreePath, "commit", "-m", "pod: task "+taskID)

	// Capture git diff from the commit.
	diff, err := gitOutput(worktreePath, "diff", "HEAD~1..HEAD")
	if err == nil {
		result.Diff = diff
	}

	names, err := gitOutput(worktreePath, "diff", "HEAD~1..HEAD", "--name-only")
	if err == nil && names != "" {
		for _, f := range strings.Split(strings.TrimSpace(names), "\n") {
			if f != "" {
				result.FilesChanged = append(result.FilesChanged, f)
			}
		}
	}

	return result, nil
}

// SetCmdCallback sets the pre-start callback.
func (a *Adapter) SetCmdCallback(cb func(*exec.Cmd)) { a.CmdCallback = cb }

// Cancel is reserved for future use (e.g. interactive session teardown).
func (a *Adapter) Cancel() {}

func filteredEnv() []string {
	env := make([]string, 0, len(os.Environ()))
	for _, e := range os.Environ() {
		if !strings.HasPrefix(e, "CLAUDECODE=") {
			env = append(env, e)
		}
	}
	return env
}

// gitOutput runs a git command in dir and returns its stdout.
func gitOutput(dir string, args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return string(out), nil
}
