// Package worker spawns CLI tool processes (headless/interactive), captures output, and handles timeouts.
package worker

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/jasjeetmavi/orca/internal/config"
	"github.com/jasjeetmavi/orca/internal/procutil"
)

// Worker executes tasks via either headless or interactive adapter modes.
type Worker interface {
	Execute(ctx context.Context, taskID, prompt, worktreePath string) (*Result, error)
	SetCmdCallback(func(*exec.Cmd))
	SetModel(string)
	SetTaskTitle(string)
	SetOutputChan(chan<- OutputLine)
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

// OutputLine is one streamed output line from a running worker process.
type OutputLine struct {
	TaskID string    `json:"task_id"`
	Stream string    `json:"stream"` // "stdout" | "stderr"
	Line   string    `json:"line"`
	Time   time.Time `json:"ts"`
}

// Adapter wraps a CLI tool binary for headless execution.
type Adapter struct {
	Binary    string
	TaskTitle string
	Args      []string
	Timeout   time.Duration
	Model     string
	// CmdCallback, if set, is called with the exec.Cmd right before it's started.
	// Use this to register the process for external tracking/cancellation.
	CmdCallback func(*exec.Cmd)
	// OutputChan receives live worker output lines.
	OutputChan chan<- OutputLine
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
		Model:   toolCfg.Model,
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
	if a.Model != "" {
		args = append(args, "--model", a.Model)
	}

	cmd := exec.CommandContext(ctx, a.Binary, args...)
	cmd.Dir = worktreePath

	// Clear env vars that prevent nesting (e.g. CLAUDECODE).
	cmd.Env = filteredEnv()
	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("stdout pipe: %w", err)
	}
	stderrPipe, err := cmd.StderrPipe()
	if err != nil {
		return nil, fmt.Errorf("stderr pipe: %w", err)
	}

	if a.CmdCallback != nil {
		a.CmdCallback(cmd)
	}

	start := time.Now()
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("exec %s: %w", a.Binary, err)
	}
	slog.Info("worker.spawned", "task_id", taskID, "binary", a.Binary, "pid", cmd.Process.Pid)

	var stdout, stderr bytes.Buffer
	var streamWG sync.WaitGroup
	streamWG.Add(2)
	go func() {
		defer streamWG.Done()
		_ = procutil.Stream(procutil.StreamOptions{
			TaskID: taskID,
			Stream: "stdout",
			Reader: stdoutPipe,
			Buffer: &stdout,
			EmitLine: func(taskID, stream, line string, ts time.Time) {
				if a.OutputChan == nil {
					return
				}
				a.OutputChan <- OutputLine{
					TaskID: taskID,
					Stream: stream,
					Line:   line,
					Time:   ts,
				}
			},
			OnError: func(err error) {
				slog.Warn("worker stream read failed", "task_id", taskID, "stream", "stdout", "err", err)
			},
		})
	}()
	go func() {
		defer streamWG.Done()
		_ = procutil.Stream(procutil.StreamOptions{
			TaskID: taskID,
			Stream: "stderr",
			Reader: stderrPipe,
			Buffer: &stderr,
			EmitLine: func(taskID, stream, line string, ts time.Time) {
				if a.OutputChan == nil {
					return
				}
				a.OutputChan <- OutputLine{
					TaskID: taskID,
					Stream: stream,
					Line:   line,
					Time:   ts,
				}
			},
			OnError: func(err error) {
				slog.Warn("worker stream read failed", "task_id", taskID, "stream", "stderr", "err", err)
			},
		})
	}()

	streamWG.Wait()
	runErr := cmd.Wait()
	duration := time.Since(start)

	result := &Result{
		TaskID:   taskID,
		Stdout:   stdout.String(),
		Stderr:   stderr.String(),
		Duration: duration,
	}

	if ctx.Err() == context.DeadlineExceeded {
		result.ExitCode = -1
		result.Stderr = result.Stderr + "\norca: process killed after timeout (" + a.Timeout.String() + ")"
	} else if ctx.Err() == context.Canceled {
		result.ExitCode = -1
		result.Stderr = result.Stderr + "\norca: process cancelled"
	} else if runErr != nil {
		if ee, ok := runErr.(*exec.ExitError); ok {
			result.ExitCode = ee.ExitCode()
		} else {
			slog.Info("worker.exited", "task_id", taskID, "exit_code", -1, "duration", duration)
			return nil, fmt.Errorf("exec %s: %w", a.Binary, runErr)
		}
	}
	slog.Info("worker.exited", "task_id", taskID, "exit_code", result.ExitCode, "duration", duration)

	// Stage all changes (including new files) and commit.
	_, _ = procutil.GitOutput(worktreePath, "add", "-A")
	commitMsg := "orca: task " + taskID
	if a.TaskTitle != "" {
		commitMsg = a.TaskTitle
	}
	_, _ = procutil.GitOutput(worktreePath, "commit", "-m", commitMsg)

	// Capture git diff from the commit.
	diff, err := procutil.GitOutput(worktreePath, "diff", "HEAD~1..HEAD")
	if err == nil {
		result.Diff = diff
	}

	names, err := procutil.GitOutput(worktreePath, "diff", "HEAD~1..HEAD", "--name-only")
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

// SetModel sets/overrides the model passed to the CLI.
func (a *Adapter) SetModel(model string)     { a.Model = model }
func (a *Adapter) SetTaskTitle(title string) { a.TaskTitle = title }

// SetOutputChan sets the live output stream channel.
func (a *Adapter) SetOutputChan(ch chan<- OutputLine) { a.OutputChan = ch }

func filteredEnv() []string {
	env := make([]string, 0, len(os.Environ()))
	for _, e := range os.Environ() {
		if !strings.HasPrefix(e, "CLAUDECODE=") {
			env = append(env, e)
		}
	}
	return env
}
