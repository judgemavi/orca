// Package worker spawns CLI tool processes and captures output.
//
// Depends on: driver.Driver, procutil
// Consumed by: executor
// Key flow: Adapter.Execute → spawn process → parse NDJSON events → Result
package worker

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/jasjeetmavi/orca/internal/driver"
	"github.com/jasjeetmavi/orca/internal/procutil"
)

// Worker executes tasks via headless adapter mode.
type Worker interface {
	Execute(ctx context.Context, taskID, prompt, worktreePath string) (*Result, error)
	ExecuteResume(ctx context.Context, taskID, sessionID, feedback, worktreePath string) (*Result, error)
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
	Events       []driver.Event
	SessionID    string
	InputTokens  int64
	OutputTokens int64
	TotalCost    float64
}

// OutputLine is one streamed output line from a running worker process.
type OutputLine struct {
	TaskID string    `json:"task_id"`
	Stream string    `json:"stream"` // "stdout" | "raw" | "stderr"
	Line   string    `json:"line"`
	Time   time.Time `json:"ts"`
}

// Adapter wraps a CLI tool binary for headless execution.
type Adapter struct {
	Driver    driver.Driver
	TaskTitle string
	Timeout   time.Duration
	Model     string
	// CmdCallback, if set, is called with the exec.Cmd right before it's started.
	CmdCallback func(*exec.Cmd)
	// OutputChan receives live worker output lines.
	OutputChan chan<- OutputLine
}

// --- private helpers ---

func (a *Adapter) executeWithArgs(ctx context.Context, taskID string, args []string, worktreePath string) (*Result, error) {
	ctx, cancel := context.WithTimeout(ctx, a.Timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, a.Driver.Binary(), args...)
	cmd.Dir = worktreePath
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
		return nil, fmt.Errorf("exec %s: %w", a.Driver.Binary(), err)
	}
	slog.Info("worker.spawned", "task_id", taskID, "binary", a.Driver.Binary(), "pid", cmd.Process.Pid)

	var stderr bytes.Buffer
	var (
		resultText strings.Builder
		totalCost  driver.Cost
		sessionID  string
		allEvents  []driver.Event
	)
	done := make(chan struct{}, 2)

	// Parse NDJSON from stdout in real-time.
	go func() {
		defer func() { done <- struct{}{} }()
		scanner := newScanner(stdoutPipe)
		for scanner.Scan() {
			line := append([]byte(nil), scanner.Bytes()...)
			now := time.Now()

			if a.OutputChan != nil {
				a.OutputChan <- OutputLine{
					TaskID: taskID,
					Stream: "raw",
					Line:   string(line),
					Time:   now,
				}
			}

			event, err := a.Driver.ParseEvent(line)
			if err != nil {
				slog.Warn("worker parse event failed", "task_id", taskID, "err", err)
				continue
			}
			allEvents = append(allEvents, event)

			switch event.Type {
			case driver.EventText:
				if event.Text == "" {
					continue
				}
				resultText.WriteString(event.Text)
				if a.OutputChan != nil {
					a.OutputChan <- OutputLine{
						TaskID: taskID,
						Stream: "stdout",
						Line:   event.Text,
						Time:   now,
					}
				}
			case driver.EventCost:
				if event.Cost != nil {
					totalCost.InputTokens += event.Cost.InputTokens
					totalCost.OutputTokens += event.Cost.OutputTokens
					totalCost.TotalCost += event.Cost.TotalCost
				}
				if event.SessionID != "" {
					sessionID = event.SessionID
				}
			case driver.EventSession:
				if event.SessionID != "" {
					sessionID = event.SessionID
				}
			}
		}
		if err := scanner.Err(); err != nil {
			slog.Warn("worker stdout scan failed", "task_id", taskID, "err", err)
		}
	}()

	// Capture stderr as raw text.
	go func() {
		defer func() { done <- struct{}{} }()
		scanner := newScanner(stderrPipe)
		for scanner.Scan() {
			line := scanner.Text()
			stderr.WriteString(line)
			stderr.WriteByte('\n')
			if a.OutputChan != nil {
				a.OutputChan <- OutputLine{
					TaskID: taskID,
					Stream: "stderr",
					Line:   line,
					Time:   time.Now(),
				}
			}
		}
		if err := scanner.Err(); err != nil {
			slog.Warn("worker stderr scan failed", "task_id", taskID, "err", err)
		}
	}()

	<-done
	<-done
	runErr := cmd.Wait()
	duration := time.Since(start)

	result := &Result{
		TaskID:       taskID,
		Stdout:       resultText.String(),
		Stderr:       stderr.String(),
		Duration:     duration,
		Events:       allEvents,
		SessionID:    sessionID,
		InputTokens:  totalCost.InputTokens,
		OutputTokens: totalCost.OutputTokens,
		TotalCost:    totalCost.TotalCost,
	}

	if ctx.Err() == context.DeadlineExceeded {
		result.ExitCode = -1
		result.Stderr += "\norca: process killed after timeout (" + a.Timeout.String() + ")"
	} else if ctx.Err() == context.Canceled {
		result.ExitCode = -1
		result.Stderr += "\norca: process cancelled"
	} else if runErr != nil {
		if ee, ok := runErr.(*exec.ExitError); ok {
			result.ExitCode = ee.ExitCode()
		} else {
			slog.Info("worker.exited", "task_id", taskID, "exit_code", -1, "duration", duration)
			return nil, fmt.Errorf("exec %s: %w", a.Driver.Binary(), runErr)
		}
	}
	slog.Info("worker.exited", "task_id", taskID, "exit_code", result.ExitCode, "duration", duration)

	_, _ = procutil.GitOutput(worktreePath, "add", "-A")
	commitMsg := "orca: task " + taskID
	if a.TaskTitle != "" {
		commitMsg = a.TaskTitle
	}
	_, _ = procutil.GitOutput(worktreePath, "commit", "-m", commitMsg)

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

func filteredEnv() []string {
	env := make([]string, 0, len(os.Environ()))
	for _, e := range os.Environ() {
		if !strings.HasPrefix(e, "CLAUDECODE=") {
			env = append(env, e)
		}
	}
	return env
}

func newScanner(r io.Reader) *bufio.Scanner {
	s := bufio.NewScanner(r)
	buf := make([]byte, 0, 64*1024)
	s.Buffer(buf, 10*1024*1024)
	return s
}

// --- exported functions/methods ---

// NewAdapter creates an Adapter from a driver and runtime settings.
func NewAdapter(d driver.Driver, model string, timeout time.Duration) *Adapter {
	return &Adapter{Driver: d, Timeout: timeout, Model: model}
}

// NewWorker creates a worker adapter.
func NewWorker(d driver.Driver, model string, timeout time.Duration) (Worker, error) {
	if d == nil {
		return nil, fmt.Errorf("driver is nil")
	}
	if timeout <= 0 {
		return nil, fmt.Errorf("timeout must be > 0")
	}
	return NewAdapter(d, model, timeout), nil
}

// Execute runs the CLI tool headlessly with the given prompt in the specified worktree.
func (a *Adapter) Execute(ctx context.Context, taskID, prompt, worktreePath string) (*Result, error) {
	if a.Driver == nil {
		return nil, fmt.Errorf("driver is nil")
	}
	if a.Timeout <= 0 {
		return nil, fmt.Errorf("timeout must be > 0")
	}

	args := a.Driver.HeadlessArgs(prompt, a.Model)
	return a.executeWithArgs(ctx, taskID, args, worktreePath)
}

// ExecuteResume resumes a prior session and applies follow-up feedback.
func (a *Adapter) ExecuteResume(ctx context.Context, taskID, sessionID, feedback, worktreePath string) (*Result, error) {
	if a.Driver == nil {
		return nil, fmt.Errorf("driver is nil")
	}
	if a.Timeout <= 0 {
		return nil, fmt.Errorf("timeout must be > 0")
	}
	args := a.Driver.ResumeArgs(sessionID, feedback, a.Model)
	return a.executeWithArgs(ctx, taskID, args, worktreePath)
}

// SetCmdCallback sets the pre-start callback.
func (a *Adapter) SetCmdCallback(cb func(*exec.Cmd)) { a.CmdCallback = cb }

// SetModel sets/overrides the model passed to the CLI.
func (a *Adapter) SetModel(model string)     { a.Model = model }
func (a *Adapter) SetTaskTitle(title string) { a.TaskTitle = title }

// SetOutputChan sets the live output stream channel.
func (a *Adapter) SetOutputChan(ch chan<- OutputLine) { a.OutputChan = ch }
