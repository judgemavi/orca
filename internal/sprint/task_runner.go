package sprint

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
	"regexp"
	"strings"
	"syscall"
	"time"

	"github.com/jasjeetmavi/orca/internal/config"
	"github.com/jasjeetmavi/orca/internal/pty"
	"github.com/jasjeetmavi/orca/internal/task"
	"github.com/jasjeetmavi/orca/internal/worker"
)

func (e *Executor) runTask(ctx context.Context, info taskInfo, outputCh chan<- worker.OutputLine) TaskResult {
	if e.sessionMgr != nil {
		return e.streamPTY(ctx, info, outputCh)
	}
	return e.streamPipe(ctx, info, outputCh)
}

func (e *Executor) startProcess(taskID string, cmd *exec.Cmd, sessionID string) {
	e.mu.Lock()
	e.running[taskID] = cmd
	if sessionID != "" {
		e.sessions[taskID] = sessionID
	}
	e.mu.Unlock()
}

func (e *Executor) streamPipe(ctx context.Context, info taskInfo, outputCh chan<- worker.OutputLine) TaskResult {
	result := TaskResult{
		TaskID:       info.taskID,
		ToolName:     info.toolName,
		Status:       "failed",
		ExitCode:     -1,
		WorktreePath: info.worktreePath,
	}

	toolCfg := info.toolCfg
	if len(info.args) > 0 {
		if strings.EqualFold(toolCfg.Mode, "interactive") && len(toolCfg.InteractiveArgs) > 0 {
			toolCfg.InteractiveArgs = append([]string(nil), info.args...)
		} else {
			toolCfg.HeadlessArgs = append([]string(nil), info.args...)
		}
	}

	workerAdapter, err := worker.NewWorker(toolCfg)
	if err != nil {
		result.Stderr = fmt.Sprintf("create adapter: %v", err)
		return result
	}
	if info.model != "" {
		workerAdapter.SetModel(info.model)
	}
	if info.taskTitle != "" {
		workerAdapter.SetTaskTitle(info.taskTitle)
	}
	workerAdapter.SetOutputChan(outputCh)
	workerAdapter.SetCmdCallback(func(cmd *exec.Cmd) {
		e.startProcess(info.taskID, cmd, "")
	})

	res, err := workerAdapter.Execute(ctx, info.taskID, info.prompt, info.worktreePath)
	if err != nil {
		result.Stderr = fmt.Sprintf("execute: %v", err)
		return result
	}

	result.ExitCode = res.ExitCode
	result.Diff = res.Diff
	result.FilesChanged = res.FilesChanged
	result.Stdout = res.Stdout
	result.Stderr = res.Stderr
	result.Duration = res.Duration
	if res.ExitCode == 0 {
		result.Status = "review"
		e.storeSessionID(info.taskID, parseSessionID(info.toolCfg.SessionIDPattern, res.Stdout))
	}
	return result
}

func (e *Executor) streamPTY(ctx context.Context, info taskInfo, outputCh chan<- worker.OutputLine) TaskResult {
	result := TaskResult{
		TaskID:       info.taskID,
		ToolName:     info.toolName,
		Status:       "failed",
		ExitCode:     -1,
		WorktreePath: info.worktreePath,
	}

	timeout, err := time.ParseDuration(info.toolCfg.Timeout)
	if err != nil {
		result.Stderr = fmt.Sprintf("parse timeout %q: %v", info.toolCfg.Timeout, err)
		return result
	}
	if timeout <= 0 {
		result.Stderr = fmt.Sprintf("invalid timeout %q: must be positive", info.toolCfg.Timeout)
		return result
	}

	args := info.args
	if len(args) == 0 {
		args = buildWorkerArgs(info.toolCfg, info.prompt, info.model, info.worktreePath)
	}
	sess, err := e.sessionMgr.Create(pty.CreateOpts{
		Type:    pty.SessionWorker,
		Command: info.toolCfg.Binary,
		Args:    args,
		Dir:     info.worktreePath,
		Tool:    info.toolName,
		TaskID:  info.taskID,
		Cols:    120,
		Rows:    40,
	})
	if err != nil {
		result.Stderr = fmt.Sprintf("create pty session: %v", err)
		return result
	}

	e.startProcess(info.taskID, sess.Cmd, sess.ID)

	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	readDone := make(chan struct{})
	go func() {
		select {
		case <-readDone:
			return
		case <-runCtx.Done():
		}
		if err := e.sessionMgr.Kill(sess.ID); err != nil {
			slog.Warn("kill PTY session failed", "session_id", sess.ID, "task_id", info.taskID, "err", err)
		}
	}()

	start := time.Now()
	stdout, streamErr := e.streamSessionPTY(info.taskID, sess.Pty, outputCh)
	close(readDone)
	result.Duration = time.Since(start)
	result.Stdout = stdout

	if streamErr != nil && !errorsIsEOF(streamErr) {
		slog.Warn("stream PTY failed", "task_id", info.taskID, "err", streamErr)
	}

	if runCtx.Err() == context.DeadlineExceeded {
		result.Stderr = "orca: process killed after timeout (" + timeout.String() + ")"
		return result
	}
	if runCtx.Err() == context.Canceled {
		result.Stderr = "orca: process cancelled"
		return result
	}

	result.ExitCode = waitSessionExitCode(sess)

	_, _ = gitOutput(info.worktreePath, "add", "-A")
	commitMsg := "orca: task " + info.taskID
	if info.taskTitle != "" {
		commitMsg = info.taskTitle
	}
	_, _ = gitOutput(info.worktreePath, "commit", "-m", commitMsg)

	base := e.config.Project.IntegrationBranch
	if diff, err := gitOutput(info.worktreePath, "diff", base+"..HEAD"); err == nil {
		result.Diff = diff
	}
	if names, err := gitOutput(info.worktreePath, "diff", base+"..HEAD", "--name-only"); err == nil && names != "" {
		for _, f := range strings.Split(strings.TrimSpace(names), "\n") {
			if f != "" {
				result.FilesChanged = append(result.FilesChanged, f)
			}
		}
	}

	if result.ExitCode == 0 {
		result.Status = "review"
		e.storeSessionID(info.taskID, parseSessionID(info.toolCfg.SessionIDPattern, result.Stdout))
	}
	return result
}

func (e *Executor) storeSessionID(taskID, sessionID string) {
	if sessionID == "" {
		return
	}
	if err := task.NewStore(e.planner.DB()).SetSessionID(taskID, sessionID); err != nil {
		slog.Warn("set session_id failed", "task_id", taskID, "session_id", sessionID, "err", err)
	}
}

func parseSessionID(pattern, output string) string {
	if pattern == "" {
		return ""
	}
	re, err := regexp.Compile(pattern)
	if err != nil {
		return ""
	}
	m := re.FindStringSubmatch(output)
	if len(m) < 2 {
		return ""
	}
	return m[1]
}

func (e *Executor) streamSessionPTY(taskID string, r io.Reader, outputCh chan<- worker.OutputLine) (string, error) {
	reader := bufio.NewReader(r)
	var output bytes.Buffer

	for {
		chunk, err := reader.ReadBytes('\n')
		if len(chunk) > 0 {
			output.Write(chunk)
			line := strings.ToValidUTF8(strings.TrimRight(string(chunk), "\r\n"), "?")
			if outputCh != nil {
				outputCh <- worker.OutputLine{
					TaskID: taskID,
					Stream: "stdout",
					Line:   line,
					Time:   time.Now().UTC(),
				}
			}
		}
		if err == io.EOF {
			return output.String(), nil
		}
		if err != nil {
			return output.String(), err
		}
	}
}

func waitSessionExitCode(sess *pty.Session) int {
	for i := 0; i < 100; i++ {
		if sess.ExitCode != -1 {
			return sess.ExitCode
		}
		if sess.Cmd != nil && sess.Cmd.ProcessState != nil {
			return sess.Cmd.ProcessState.ExitCode()
		}
		time.Sleep(10 * time.Millisecond)
	}
	return sess.ExitCode
}

func errorsIsEOF(err error) bool {
	return err == io.EOF || strings.Contains(strings.ToLower(err.Error()), "file already closed")
}

func buildWorkerArgs(toolCfg config.ToolConfig, prompt, model, worktreePath string) []string {
	argsCfg := toolCfg.HeadlessArgs
	if strings.EqualFold(toolCfg.Mode, "interactive") && len(toolCfg.InteractiveArgs) > 0 {
		argsCfg = toolCfg.InteractiveArgs
	}

	contextContent := loadContextFromWorktree(worktreePath)
	args := make([]string, len(argsCfg))
	for i, arg := range argsCfg {
		arg = strings.ReplaceAll(arg, "{{prompt}}", prompt)
		arg = strings.ReplaceAll(arg, "{{context}}", contextContent)
		args[i] = arg
	}

	selectedModel := toolCfg.Model
	if model != "" {
		selectedModel = model
	}
	if selectedModel != "" {
		args = append(args, "--model", selectedModel)
	}
	return args
}

func buildResumeArgs(toolCfg config.ToolConfig, sessionID, feedback, model string) []string {
	args := make([]string, len(toolCfg.ResumeArgs))
	for i, arg := range toolCfg.ResumeArgs {
		arg = strings.ReplaceAll(arg, "{{session_id}}", sessionID)
		arg = strings.ReplaceAll(arg, "{{feedback}}", feedback)
		args[i] = arg
	}

	selectedModel := toolCfg.Model
	if model != "" {
		selectedModel = model
	}
	if selectedModel != "" {
		args = append(args, "--model", selectedModel)
	}
	return args
}

func loadContextFromWorktree(worktreePath string) string {
	data, err := os.ReadFile(filepath.Join(worktreePath, ".orca", "context.md"))
	if err != nil {
		return ""
	}
	return string(data)
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

func (e *Executor) killProcess(taskID string) {
	e.mu.Lock()
	cmd, ok := e.running[taskID]
	sessionID := e.sessions[taskID]
	e.mu.Unlock()
	if e.sessionMgr != nil && sessionID != "" {
		if err := e.sessionMgr.Kill(sessionID); err != nil {
			slog.Warn("kill PTY session failed", "session_id", sessionID, "task_id", taskID, "err", err)
		}
		return
	}
	if ok && cmd != nil && cmd.Process != nil {
		_ = cmd.Process.Signal(syscall.SIGINT)
	}
}
