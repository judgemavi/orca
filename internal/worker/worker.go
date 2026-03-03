// Package worker spawns CLI tool processes and captures raw output.
//
// Depends on: procutil, toolcfg
// Consumed by: executor
// Key flow: Adapter.Execute → spawn process → capture raw stdout/stderr → Result
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

	"github.com/jasjeetmavi/orca/internal/orchestrator"
	"github.com/jasjeetmavi/orca/internal/procutil"
	"github.com/jasjeetmavi/orca/internal/toolcfg"
)

// Worker executes tasks via headless adapter mode.
type Worker interface {
	Execute(ctx context.Context, taskID, prompt, worktreePath string) (*Result, error)
	ExecuteResume(ctx context.Context, taskID, sessionID, feedback, worktreePath string) (*Result, error)
	SetCmdCallback(func(*exec.Cmd))
	SetModel(string)
	SetTaskTitle(string)
	SetOutputChan(chan<- OutputLine)
	SetSessionIDCallback(func(string))
	SetToolDefinition(toolName string, tool toolcfg.Tool)
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
	ToolName  string
	Tool      toolcfg.Tool
	TaskTitle string
	Timeout   time.Duration
	Model     string
	// CmdCallback, if set, is called with the exec.Cmd right before it's started.
	CmdCallback func(*exec.Cmd)
	// OutputChan receives live worker output lines.
	OutputChan chan<- OutputLine
	// SessionIDCallback receives observed session IDs from raw output scan.
	SessionIDCallback func(string)
}

// --- private helpers ---

func (a *Adapter) executeWithArgs(ctx context.Context, taskID string, tool toolcfg.Tool, args []string, worktreePath string) (*Result, error) {
	timeout := a.Timeout
	if timeout <= 0 {
		parsed, err := tool.TimeoutDuration()
		if err == nil && parsed > 0 {
			timeout = parsed
		} else {
			timeout = 10 * time.Minute
		}
	}

	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	if worktreePath != "" {
		if _, err := os.Stat(worktreePath); err != nil {
			return nil, fmt.Errorf("worktree dir %s: %w", worktreePath, err)
		}
	}
	binary := strings.TrimSpace(tool.Binary)
	if binary == "" {
		return nil, fmt.Errorf("tool binary is empty")
	}

	cmd := exec.CommandContext(ctx, binary, args...)
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

	slog.Info("worker.starting", "task_id", taskID, "binary", binary, "dir", worktreePath, "args_count", len(args))

	start := time.Now()
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("exec %s in %s: %w", binary, worktreePath, err)
	}
	slog.Info("worker.spawned", "task_id", taskID, "binary", binary, "pid", cmd.Process.Pid, "dir", worktreePath)

	var stderr bytes.Buffer
	var stdout bytes.Buffer
	sessionID := ""
	observeSessionID := func(rawLine string) {
		matched := toolcfg.ExtractSessionID(tool.SessionID, rawLine)
		if matched == "" || matched == sessionID {
			return
		}
		sessionID = matched
		if a.SessionIDCallback != nil {
			a.SessionIDCallback(matched)
		}
	}
	done := make(chan struct{}, 2)

	// Capture stdout as raw text and scan for session ID.
	go func() {
		defer func() { done <- struct{}{} }()
		scanner := newScanner(stdoutPipe)
		for scanner.Scan() {
			line := scanner.Text()
			now := time.Now()
			stdout.WriteString(line)
			stdout.WriteByte('\n')
			observeSessionID(line)

			if a.OutputChan != nil {
				a.OutputChan <- OutputLine{
					TaskID: taskID,
					Stream: "raw",
					Line:   line,
					Time:   now,
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
		TaskID:    taskID,
		Stdout:    stdout.String(),
		Stderr:    stderr.String(),
		Duration:  duration,
		SessionID: sessionID,
	}

	if ctx.Err() == context.DeadlineExceeded {
		result.ExitCode = -1
		result.Stderr += "\norca: process killed after timeout (" + timeout.String() + ")"
	} else if ctx.Err() == context.Canceled {
		result.ExitCode = -1
		result.Stderr += "\norca: process cancelled"
	} else if runErr != nil {
		if ee, ok := runErr.(*exec.ExitError); ok {
			result.ExitCode = ee.ExitCode()
		} else {
			slog.Info("worker.exited", "task_id", taskID, "exit_code", -1, "duration", duration)
			return nil, fmt.Errorf("exec %s: %w", binary, runErr)
		}
	}
	logFields := []any{"task_id", taskID, "exit_code", result.ExitCode, "duration", duration, "dir", worktreePath}
	if result.ExitCode != 0 && result.Stderr != "" {
		// Truncate stderr for log readability.
		stderrSnippet := result.Stderr
		if len(stderrSnippet) > 500 {
			stderrSnippet = stderrSnippet[len(stderrSnippet)-500:]
		}
		logFields = append(logFields, "stderr", stderrSnippet)
	}
	slog.Info("worker.exited", logFields...)

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

// NewAdapter creates an Adapter from a tool and runtime settings.
func NewAdapter(toolName string, tool toolcfg.Tool, model string, timeout time.Duration) *Adapter {
	return &Adapter{ToolName: strings.TrimSpace(toolName), Tool: tool, Timeout: timeout, Model: model}
}

// NewWorker creates a worker adapter.
func NewWorker(toolName string, tool toolcfg.Tool, model string, timeout time.Duration) (Worker, error) {
	if timeout <= 0 {
		return nil, fmt.Errorf("timeout must be > 0")
	}
	return NewAdapter(toolName, tool, model, timeout), nil
}

// Execute runs the CLI tool headlessly with the given prompt in the specified worktree.
func (a *Adapter) Execute(ctx context.Context, taskID, prompt, worktreePath string) (*Result, error) {
	tool, err := a.resolveToolDefinition(worktreePath)
	if err != nil {
		return nil, err
	}
	args := a.buildArgs(tool, toolcfg.ArgsModeHeadless, map[string]string{
		"prompt": prompt,
		"model":  a.Model,
		"dir":    worktreePath,
	})
	return a.executeWithArgs(ctx, taskID, tool, args, worktreePath)
}

// ExecuteResume resumes a prior session and applies follow-up feedback.
func (a *Adapter) ExecuteResume(ctx context.Context, taskID, sessionID, feedback, worktreePath string) (*Result, error) {
	tool, err := a.resolveToolDefinition(worktreePath)
	if err != nil {
		return nil, err
	}
	args := a.buildArgs(tool, toolcfg.ArgsModeResume, map[string]string{
		"session_id": sessionID,
		"feedback":   feedback,
		"model":      a.Model,
		"dir":        worktreePath,
	})
	return a.executeWithArgs(ctx, taskID, tool, args, worktreePath)
}

// SetCmdCallback sets the pre-start callback.
func (a *Adapter) SetCmdCallback(cb func(*exec.Cmd)) { a.CmdCallback = cb }

// SetModel sets/overrides the model passed to the CLI.
func (a *Adapter) SetModel(model string)     { a.Model = model }
func (a *Adapter) SetTaskTitle(title string) { a.TaskTitle = title }

// SetOutputChan sets the live output stream channel.
func (a *Adapter) SetOutputChan(ch chan<- OutputLine) { a.OutputChan = ch }

// SetSessionIDCallback sets the callback for observed session IDs.
func (a *Adapter) SetSessionIDCallback(cb func(string)) { a.SessionIDCallback = cb }

// SetToolDefinition sets an explicit tool definition for this adapter.
func (a *Adapter) SetToolDefinition(toolName string, tool toolcfg.Tool) {
	a.ToolName = strings.TrimSpace(toolName)
	a.Tool = tool
}

func (a *Adapter) resolveToolDefinition(pathHint string) (toolcfg.Tool, error) {
	if strings.TrimSpace(a.Tool.Binary) != "" {
		return a.Tool, nil
	}
	toolName := strings.TrimSpace(a.ToolName)
	if toolName == "" {
		return toolcfg.Tool{}, fmt.Errorf("tool name is required")
	}

	tool, err := orchestrator.ResolveToolDefinition(pathHint, toolName)
	if err != nil {
		return toolcfg.Tool{}, fmt.Errorf("resolve tool %q definition: %w", toolName, err)
	}
	a.Tool = tool
	if strings.TrimSpace(a.ToolName) == "" {
		a.ToolName = toolName
	}
	return tool, nil
}

func (a *Adapter) buildArgs(tool toolcfg.Tool, mode string, vars map[string]string) []string {
	return compactArgs(tool.ResolveArgs(mode, vars))
}

func compactArgs(args []string) []string {
	out := make([]string, 0, len(args))
	for i := 0; i < len(args); i++ {
		current := strings.TrimSpace(args[i])
		if current == "" {
			continue
		}
		if takesValueFlag(current) && i+1 < len(args) && strings.TrimSpace(args[i+1]) == "" {
			i++
			continue
		}
		out = append(out, args[i])
	}
	return out
}

func takesValueFlag(arg string) bool {
	switch arg {
	case "--model", "--mcp-config", "--allowedTools", "--append-system-prompt", "--resume", "-C", "--prompt", "-p":
		return true
	default:
		return false
	}
}
