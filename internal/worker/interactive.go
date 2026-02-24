package worker

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"os/exec"
	"strings"
	"time"

	"github.com/creack/pty"
	"github.com/jasjeetmavi/orca/internal/driver"
	"github.com/jasjeetmavi/orca/internal/procutil"
)

// InteractiveAdapter runs a CLI tool in a pseudo-terminal for full interactive capability.
type InteractiveAdapter struct {
	Driver      driver.Driver
	Binary      string
	Args        []string
	Timeout     time.Duration
	Model       string
	TaskTitle   string
	CmdCallback func(*exec.Cmd)
	PromptMode  string
	OutputChan  chan<- OutputLine
}

// NewInteractiveAdapter creates an InteractiveAdapter from a driver.
func NewInteractiveAdapter(d driver.Driver, model string, timeout time.Duration) *InteractiveAdapter {
	return &InteractiveAdapter{
		Driver:     d,
		Binary:     d.Binary(),
		Args:       d.InteractiveArgs("", "", "{{context}}", model),
		Timeout:    timeout,
		Model:      model,
		PromptMode: "arg",
	}
}

// Execute runs the CLI tool with a PTY in the specified worktree.
func (a *InteractiveAdapter) Execute(ctx context.Context, taskID, prompt, worktreePath string) (*Result, error) {
	if a.Driver == nil {
		return nil, fmt.Errorf("driver is nil")
	}
	if a.Timeout <= 0 {
		return nil, fmt.Errorf("timeout must be > 0")
	}

	ctx, cancel := context.WithTimeout(ctx, a.Timeout)
	defer cancel()

	contextContent := procutil.LoadContextFromWorktree(worktreePath)

	args := make([]string, len(a.Args))
	for i, arg := range a.Args {
		arg = strings.ReplaceAll(arg, "{{prompt}}", prompt)
		arg = strings.ReplaceAll(arg, "{{context}}", contextContent)
		args[i] = arg
	}
	if a.Model != "" {
		args = append(args, "--model", a.Model)
	}

	cmd := exec.CommandContext(ctx, a.Binary, args...)
	cmd.Dir = worktreePath
	cmd.Env = filteredEnv()

	if a.CmdCallback != nil {
		a.CmdCallback(cmd)
	}

	start := time.Now()
	ptmx, err := pty.Start(cmd)
	if err != nil {
		return nil, fmt.Errorf("exec %s: %w", a.Binary, err)
	}
	defer ptmx.Close()

	var stderr bytes.Buffer
	var (
		resultText strings.Builder
		totalCost  driver.Cost
		sessionID  string
		events     []driver.Event
	)

	copyDone := make(chan struct{})
	go func() {
		scanner := newScanner(ptmx)
		for scanner.Scan() {
			line := append([]byte(nil), scanner.Bytes()...)
			now := time.Now()
			if a.OutputChan != nil {
				a.OutputChan <- OutputLine{TaskID: taskID, Stream: "raw", Line: string(line), Time: now}
			}
			event, err := a.Driver.ParseEvent(line)
			if err != nil {
				slog.Warn("worker parse event failed", "task_id", taskID, "err", err)
				continue
			}
			events = append(events, event)
			switch event.Type {
			case driver.EventText:
				if event.Text == "" {
					continue
				}
				resultText.WriteString(event.Text)
				if a.OutputChan != nil {
					a.OutputChan <- OutputLine{TaskID: taskID, Stream: "stdout", Line: event.Text, Time: now}
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
			slog.Warn("worker stream PTY failed", "task_id", taskID, "err", err)
		}
		close(copyDone)
	}()

	if strings.EqualFold(strings.TrimSpace(a.PromptMode), "stdin") && prompt != "" {
		_, _ = ptmx.Write([]byte(prompt + "\n"))
	}

	waitErr := cmd.Wait()
	duration := time.Since(start)
	_ = ptmx.Close()
	<-copyDone

	result := &Result{
		TaskID:       taskID,
		Stdout:       resultText.String(),
		Stderr:       stderr.String(),
		Duration:     duration,
		Events:       events,
		SessionID:    sessionID,
		InputTokens:  totalCost.InputTokens,
		OutputTokens: totalCost.OutputTokens,
		TotalCost:    totalCost.TotalCost,
	}

	if ctx.Err() == context.DeadlineExceeded {
		result.ExitCode = -1
		result.Stderr = "orca: process killed after timeout (" + a.Timeout.String() + ")"
	} else if ctx.Err() == context.Canceled {
		result.ExitCode = -1
		result.Stderr = "orca: process cancelled"
	} else if waitErr != nil {
		if ee, ok := waitErr.(*exec.ExitError); ok {
			result.ExitCode = ee.ExitCode()
		} else {
			return nil, fmt.Errorf("exec %s: %w", a.Binary, waitErr)
		}
	}

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

func (a *InteractiveAdapter) ExecuteResume(ctx context.Context, taskID, sessionID, feedback, worktreePath string) (*Result, error) {
	return nil, fmt.Errorf("interactive resume is not supported")
}

// SetCmdCallback sets the pre-start callback.
func (a *InteractiveAdapter) SetCmdCallback(cb func(*exec.Cmd)) { a.CmdCallback = cb }

// SetModel sets/overrides the model passed to the CLI.
func (a *InteractiveAdapter) SetModel(model string)     { a.Model = model }
func (a *InteractiveAdapter) SetTaskTitle(title string) { a.TaskTitle = title }

// SetOutputChan sets the live output stream channel.
func (a *InteractiveAdapter) SetOutputChan(ch chan<- OutputLine) { a.OutputChan = ch }
