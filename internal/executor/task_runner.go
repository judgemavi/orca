package executor

// task_runner.go runs a single task via pipe or PTY mode.
//
// Called by: collectResult (batch) and RunSingleWithOpts (single re-run)
// Key flow: runTask → streamPipe|streamPTY → collect diff + artifacts

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"os/exec"
	"strings"
	"syscall"
	"time"

	"github.com/jasjeetmavi/orca/internal/driver"
	"github.com/jasjeetmavi/orca/internal/procutil"
	"github.com/jasjeetmavi/orca/internal/pty"
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

	workerAdapter, err := worker.NewWorker(info.driver, info.model, info.timeout)
	if err != nil {
		result.Stderr = fmt.Sprintf("create adapter: %v", err)
		return result
	}
	if info.taskTitle != "" {
		workerAdapter.SetTaskTitle(info.taskTitle)
	}
	workerAdapter.SetOutputChan(outputCh)
	workerAdapter.SetCmdCallback(func(cmd *exec.Cmd) {
		e.startProcess(info.taskID, cmd, "")
	})

	var (
		res     *worker.Result
		execErr error
	)
	if info.resumeSessionID != "" {
		res, execErr = workerAdapter.ExecuteResume(ctx, info.taskID, info.resumeSessionID, info.resumeFeedback, info.worktreePath)
	} else {
		res, execErr = workerAdapter.Execute(ctx, info.taskID, info.prompt, info.worktreePath)
	}
	if execErr != nil {
		result.Stderr = fmt.Sprintf("execute: %v", execErr)
		return result
	}

	result.ExitCode = res.ExitCode
	result.Diff = res.Diff
	result.FilesChanged = res.FilesChanged
	result.Stdout = res.Stdout
	result.Stderr = res.Stderr
	result.Duration = res.Duration
	result.InputTokens = res.InputTokens
	result.OutputTokens = res.OutputTokens
	result.TotalCost = res.TotalCost
	if res.ExitCode == 0 {
		result.Status = "review"
		e.storeSessionID(info.taskID, res.SessionID)
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

	timeout := info.timeout
	if timeout <= 0 {
		result.Stderr = "invalid timeout: must be positive"
		return result
	}

	args := info.args
	if len(args) == 0 {
		args = buildWorkerArgs(info, info.prompt, info.model, info.worktreePath)
	}
	sess, err := e.sessionMgr.Create(pty.CreateOpts{
		Type:    pty.SessionWorker,
		Command: info.driver.Binary(),
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
	var rawOutput bytes.Buffer
	var parsedText strings.Builder
	var totalCost driver.Cost
	sessionID := ""
	scanner := bufio.NewScanner(sess.Pty)
	scanner.Buffer(make([]byte, 0, 64*1024), 10*1024*1024)
	for scanner.Scan() {
		line := append([]byte(nil), scanner.Bytes()...)
		rawOutput.WriteString(string(line))
		rawOutput.WriteByte('\n')
		now := time.Now()
		if outputCh != nil {
			outputCh <- worker.OutputLine{
				TaskID: info.taskID,
				Stream: "raw",
				Line:   string(line),
				Time:   now,
			}
		}
		event, err := info.driver.ParseEvent(line)
		if err != nil {
			slog.Warn("parse PTY event failed", "task_id", info.taskID, "err", err)
			continue
		}
		switch event.Type {
		case driver.EventText:
			if event.Text == "" {
				continue
			}
			parsedText.WriteString(event.Text)
			if outputCh != nil {
				outputCh <- worker.OutputLine{
					TaskID: info.taskID,
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
	streamErr := scanner.Err()
	close(readDone)
	result.Duration = time.Since(start)
	result.Stdout = parsedText.String()
	if result.Stdout == "" {
		result.Stdout = rawOutput.String()
	}
	result.InputTokens = totalCost.InputTokens
	result.OutputTokens = totalCost.OutputTokens
	result.TotalCost = totalCost.TotalCost

	if streamErr != nil {
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

	_, _ = procutil.GitOutput(info.worktreePath, "add", "-A")
	commitMsg := "orca: task " + info.taskID
	if info.taskTitle != "" {
		commitMsg = info.taskTitle
	}
	_, _ = procutil.GitOutput(info.worktreePath, "commit", "-m", commitMsg)

	base := e.config.Project.IntegrationBranch
	if diff, err := procutil.GitOutput(info.worktreePath, "diff", base+"..HEAD"); err == nil {
		result.Diff = diff
	}
	if names, err := procutil.GitOutput(info.worktreePath, "diff", base+"..HEAD", "--name-only"); err == nil && names != "" {
		for _, f := range strings.Split(strings.TrimSpace(names), "\n") {
			if f != "" {
				result.FilesChanged = append(result.FilesChanged, f)
			}
		}
	}

	if result.ExitCode == 0 {
		result.Status = "review"
		e.storeSessionID(info.taskID, sessionID)
	}
	return result
}

func (e *Executor) storeSessionID(taskID, sessionID string) {
	if sessionID == "" {
		return
	}
	if err := e.taskStore.SetSessionID(taskID, sessionID); err != nil {
		slog.Warn("set session_id failed", "task_id", taskID, "session_id", sessionID, "err", err)
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

func buildWorkerArgs(info taskInfo, prompt, model, worktreePath string) []string {
	contextContent := procutil.LoadContextFromWorktree(worktreePath)
	args := info.driver.HeadlessArgs(prompt, model)
	for i := range args {
		args[i] = strings.ReplaceAll(args[i], "{{context}}", contextContent)
	}
	return args
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
