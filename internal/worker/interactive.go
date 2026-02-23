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
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/creack/pty"
	"github.com/jasjeetmavi/orca/internal/config"
)

// InteractiveAdapter runs a CLI tool in a pseudo-terminal for full interactive capability.
type InteractiveAdapter struct {
	Binary      string
	Args        []string
	Timeout     time.Duration
	Model       string
	TaskTitle   string
	CmdCallback func(*exec.Cmd)
	PromptMode  string
	OutputChan  chan<- OutputLine

	mu   sync.Mutex
	ptmx *os.File
}

// NewInteractiveAdapter creates an InteractiveAdapter from a ToolConfig.
func NewInteractiveAdapter(toolCfg config.ToolConfig) (*InteractiveAdapter, error) {
	timeout, err := time.ParseDuration(toolCfg.Timeout)
	if err != nil {
		return nil, fmt.Errorf("parse timeout %q: %w", toolCfg.Timeout, err)
	}

	return &InteractiveAdapter{
		Binary:     toolCfg.Binary,
		Args:       toolCfg.InteractiveArgs,
		Timeout:    timeout,
		Model:      toolCfg.Model,
		PromptMode: toolCfg.PromptMode,
	}, nil
}

// Execute runs the CLI tool with a PTY in the specified worktree.
func (a *InteractiveAdapter) Execute(ctx context.Context, taskID, prompt, worktreePath string) (*Result, error) {
	ctx, cancel := context.WithTimeout(ctx, a.Timeout)
	defer cancel()

	contextContent := loadContextFromWorktree(worktreePath)

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

	a.mu.Lock()
	a.ptmx = ptmx
	a.mu.Unlock()
	defer func() {
		a.mu.Lock()
		a.ptmx = nil
		a.mu.Unlock()
	}()

	var output bytes.Buffer
	copyDone := make(chan struct{})
	go func() {
		streamPTY(taskID, ptmx, &output, a.OutputChan)
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
		TaskID:   taskID,
		Stdout:   output.String(),
		Stderr:   "",
		Duration: duration,
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

	_, _ = gitOutput(worktreePath, "add", "-A")
	commitMsg := "orca: task " + taskID
	if a.TaskTitle != "" {
		commitMsg = a.TaskTitle
	}
	_, _ = gitOutput(worktreePath, "commit", "-m", commitMsg)

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

// Cancel closes the PTY master to terminate the interactive session.
func (a *InteractiveAdapter) Cancel() {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.ptmx != nil {
		_ = a.ptmx.Close()
	}
}

// SetCmdCallback sets the pre-start callback.
func (a *InteractiveAdapter) SetCmdCallback(cb func(*exec.Cmd)) { a.CmdCallback = cb }

// SetModel sets/overrides the model passed to the CLI.
func (a *InteractiveAdapter) SetModel(model string)     { a.Model = model }
func (a *InteractiveAdapter) SetTaskTitle(title string) { a.TaskTitle = title }

// SetOutputChan sets the live output stream channel.
func (a *InteractiveAdapter) SetOutputChan(ch chan<- OutputLine) { a.OutputChan = ch }

func loadContextFromWorktree(worktreePath string) string {
	data, err := os.ReadFile(filepath.Join(worktreePath, ".orca", "context.md"))
	if err != nil {
		return ""
	}
	return string(data)
}

func streamPTY(taskID string, r io.Reader, outBuf *bytes.Buffer, outputChan chan<- OutputLine) {
	reader := bufio.NewReader(r)
	for {
		chunk, err := reader.ReadBytes('\n')
		if len(chunk) > 0 {
			outBuf.Write(chunk)
			line := strings.ToValidUTF8(strings.TrimRight(string(chunk), "\r\n"), "?")
			if outputChan != nil {
				outputChan <- OutputLine{
					TaskID: taskID,
					Stream: "stdout",
					Line:   line,
					Time:   time.Now().UTC(),
				}
			}
		}
		if err == io.EOF {
			return
		}
		if err != nil {
			slog.Warn("worker stream PTY failed", "task_id", taskID, "err", err)
			return
		}
	}
}
