package executor

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/google/uuid"
	"github.com/jasjeetmavi/orca/internal/config"
	"github.com/jasjeetmavi/orca/internal/cost"
	"github.com/jasjeetmavi/orca/internal/explore"
	"github.com/jasjeetmavi/orca/internal/monitor"
	"github.com/jasjeetmavi/orca/internal/pty"
	"github.com/jasjeetmavi/orca/internal/quality"
	"github.com/jasjeetmavi/orca/internal/state"
	"github.com/jasjeetmavi/orca/internal/task"
	"github.com/jasjeetmavi/orca/internal/worker"
	"github.com/jasjeetmavi/orca/internal/worktree"
	"github.com/jasjeetmavi/orca/prompts"
)

// TaskResult holds the outcome of a single task execution.
type TaskResult struct {
	TaskID       string        `json:"task_id"`
	ToolName     string        `json:"tool_name"`
	Status       string        `json:"status"` // "review" or "failed"
	ExitCode     int           `json:"exit_code"`
	Diff         string        `json:"diff,omitempty"`
	FilesChanged []string      `json:"files_changed,omitempty"`
	Stdout       string        `json:"stdout,omitempty"`
	Stderr       string        `json:"stderr,omitempty"`
	Duration     time.Duration `json:"duration"`
	WorktreePath string        `json:"worktree_path,omitempty"`
}

type taskInfo struct {
	taskID       string
	taskTitle    string
	toolName     string
	toolCfg      config.ToolConfig
	worktreePath string
	prompt       string
	model        string
	args         []string
}

// ExecutorOptions configures optional executor dependencies and callbacks.
type ExecutorOptions struct {
	CostTracker   *cost.Tracker
	OutputHook    func(worker.OutputLine)
	DoneHook      func(taskID string, exitCode int)
	BroadcastHook func(taskID, status string)
}

// Executor orchestrates task execution: worktree creation, parallel worker
// spawning, result collection, and artifact storage.
type Executor struct {
	db         *state.DB
	taskStore  *task.Store
	worktrees  *worktree.Manager
	config     *config.Config
	repoDir    string
	sessionMgr *pty.SessionManager

	// Cost tracking (optional — nil means no tracking).
	costTracker *cost.Tracker
	// Runtime monitors.
	monitors []monitor.Monitor

	// Cancel support.
	cancel   context.CancelFunc
	runCtx   context.Context
	mu       sync.Mutex
	running  map[string]*exec.Cmd
	sessions map[string]string
	runID    string // ephemeral, set during RunBatch

	outputHook func(worker.OutputLine)
	doneHook   func(taskID string, exitCode int)

	// Optional task status broadcast callback (e.g. WS event emitter).
	broadcastHook func(taskID, status string)
	monitorHook   func(alertType, taskID, message string)

	// Run-scoped quality baseline used during artifact storage.
	runBaselineSnapshot *quality.Snapshot
}

// NewExecutor creates an Executor wired to DB, task store, worktree manager,
// config, and repo directory.
func NewExecutor(db *state.DB, taskStore *task.Store, wm *worktree.Manager, cfg *config.Config, repoDir string, opts ExecutorOptions, sessionMgr ...*pty.SessionManager) *Executor {
	var mgr *pty.SessionManager
	if len(sessionMgr) > 0 {
		mgr = sessionMgr[0]
	}
	return &Executor{
		db:            db,
		taskStore:     taskStore,
		worktrees:     wm,
		config:        cfg,
		repoDir:       repoDir,
		sessionMgr:    mgr,
		running:       make(map[string]*exec.Cmd),
		sessions:      make(map[string]string),
		costTracker:   opts.CostTracker,
		outputHook:    opts.OutputHook,
		doneHook:      opts.DoneHook,
		broadcastHook: opts.BroadcastHook,
	}
}

// Worktrees returns the underlying worktree manager.
func (e *Executor) Worktrees() *worktree.Manager { return e.worktrees }

// SetMonitorAlertHook sets a callback for runtime monitor alerts.
func (e *Executor) SetMonitorAlertHook(fn func(alertType, taskID, message string)) {
	e.monitorHook = fn
}

// IsTaskRunning reports whether a task process is currently running.
func (e *Executor) IsTaskRunning(taskID string) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	_, ok := e.running[taskID]
	return ok
}

func (e *Executor) budgetAwareEnabled() bool {
	return e.config.Monitor.TaskBudget > 0 || e.config.Orchestrator.CostBudget > 0
}

// RunBatch executes all tasks in a batch: transitions to running, creates worktrees,
// runs workers in parallel, collects results, updates task statuses, stores artifacts.
func (e *Executor) RunBatch(taskIDs []string) ([]TaskResult, error) {
	maxParallel := e.config.Workers.MaxParallel
	if maxParallel <= 0 {
		maxParallel = 1
	}
	if len(taskIDs) > maxParallel {
		return nil, fmt.Errorf("batch has %d tasks, exceeds workers.max_parallel=%d", len(taskIDs), maxParallel)
	}

	if err := e.worktrees.EnsureIntegrationBranch(e.config.Project.IntegrationBranch); err != nil {
		return nil, fmt.Errorf("ensure integration branch: %w", err)
	}

	for _, id := range taskIDs {
		if err := e.taskStore.Update(id, map[string]interface{}{"status": "running"}); err != nil {
			return nil, fmt.Errorf("set task %s running: %w", id, err)
		}
		if e.broadcastHook != nil {
			e.broadcastHook(id, "running")
		}
	}

	runID := uuid.New().String()
	e.runID = runID
	ctx, cancel := context.WithCancel(context.Background())
	e.cancel = cancel
	e.runCtx = ctx
	defer func() {
		e.runCtx = nil
		e.runID = ""
	}()

	contextPrefix := ""
	if cctx := explore.LoadContext(e.repoDir); cctx != "" {
		contextPrefix = "## Codebase Context\n\n" + cctx + "\n\n---\n\n"
	}

	prepared, _, err := e.prepareTasks(taskIDs, contextPrefix)
	if err != nil {
		e.rollbackPreparation(taskIDs)
		return nil, err
	}

	monCancel := e.startMonitors(ctx, taskIDs)
	defer e.stopMonitors(monCancel)

	baselineSnapshot := e.takeBaselineSnapshot()
	e.runBaselineSnapshot = baselineSnapshot
	defer func() { e.runBaselineSnapshot = nil }()

	results := e.collectResult(prepared, baselineSnapshot)
	e.storeArtifacts(runID, results)
	e.recordCost(runID, prepared, results)
	if err := e.finalizeRun(results); err != nil {
		return results, err
	}
	return results, nil
}

func (e *Executor) prepareTasks(taskIDs []string, contextPrefix string) ([]taskInfo, []string, error) {
	prepared := make([]taskInfo, 0, len(taskIDs))
	createdTaskIDs := make([]string, 0, len(taskIDs))

	for _, taskID := range taskIDs {
		t, err := e.taskStore.Get(taskID)
		if err != nil {
			return nil, createdTaskIDs, fmt.Errorf("get task %s: %w", taskID, err)
		}

		toolName, toolCfg, err := e.resolveTaskToolConfig("run")
		if err != nil {
			return nil, createdTaskIDs, fmt.Errorf("resolve tool for task %s: %w", taskID, err)
		}
		model := toolCfg.Model

		wtPath, _, err := e.worktrees.Create(taskID, e.config.Project.IntegrationBranch, t.Title)
		if err != nil {
			return nil, createdTaskIDs, fmt.Errorf("create worktree for task %s: %w", taskID, err)
		}
		createdTaskIDs = append(createdTaskIDs, taskID)

		prompt := t.Title + "\n\n" + t.Description
		if t.Plan != "" {
			prompt = "## Implementation Plan\n\n" + t.Plan + "\n\n---\n\n## Task\n\n" + prompt
		}
		if contextPrefix != "" {
			prompt = contextPrefix + prompt
		}
		if e.budgetAwareEnabled() {
			prompt = strings.TrimSpace(prompts.BudgetAware) + "\n\n---\n\n" + prompt
		}
		prompt = strings.TrimSpace(prompts.OutputStyle) + "\n\n---\n\n" + prompt

		prepared = append(prepared, taskInfo{
			taskID:       taskID,
			taskTitle:    t.Title,
			toolName:     toolName,
			toolCfg:      toolCfg,
			worktreePath: wtPath,
			prompt:       prompt,
			model:        model,
		})
	}

	return prepared, createdTaskIDs, nil
}

func (e *Executor) finalizeRun(results []TaskResult) error {
	failedCount := 0
	succeededCount := 0
	for _, r := range results {
		if err := e.taskStore.Update(r.TaskID, map[string]interface{}{"status": r.Status}); err != nil {
			slog.Warn("complete task failed", "task_id", r.TaskID, "run_id", e.runID, "err", err)
		}
		if r.Status == "failed" {
			failedCount++
		} else {
			succeededCount++
		}
	}

	slog.Info("run.executed", "run_id", e.runID, "succeeded", succeededCount, "failed", failedCount)
	return nil
}

func (e *Executor) emitDone(taskID string, exitCode int) {
	if e.doneHook != nil {
		e.doneHook(taskID, exitCode)
	}
}

func (e *Executor) emitMonitorAlert(alertType, taskID, message string) {
	if e.monitorHook != nil {
		e.monitorHook(alertType, taskID, message)
	}
}

// RunSingle re-runs a single task with review feedback, reusing the existing
// worktree and resuming the tool session when supported.
func (e *Executor) RunSingle(ctx context.Context, taskID string) error {
	if ctx == nil {
		ctx = context.Background()
	}
	runID := uuid.New().String()

	t, err := e.taskStore.Get(taskID)
	if err != nil {
		return fmt.Errorf("get task %s: %w", taskID, err)
	}

	toolName, toolCfg, err := e.resolveTaskToolConfig("run")
	if err != nil {
		return fmt.Errorf("resolve tool for task %s: %w", taskID, err)
	}
	model := toolCfg.Model

	wtPath := worktree.ResolveTaskDir(e.config.Project.WorktreeDir, taskID)
	if _, err := os.Stat(wtPath); err != nil {
		if !os.IsNotExist(err) {
			return fmt.Errorf("stat worktree for task %s: %w", taskID, err)
		}
		createdPath, _, err := e.worktrees.Create(taskID, e.config.Project.IntegrationBranch, t.Title)
		if err != nil {
			return fmt.Errorf("create worktree for task %s: %w", taskID, err)
		}
		wtPath = createdPath
	}

	contextPrefix := ""
	if cctx := explore.LoadContext(e.repoDir); cctx != "" {
		contextPrefix = "## Codebase Context\n\n" + cctx + "\n\n---\n\n"
	}

	prompt := t.Title + "\n\n" + t.Description
	if t.Plan != "" {
		prompt = "## Implementation Plan\n\n" + t.Plan + "\n\n---\n\n## Task\n\n" + prompt
	}
	if contextPrefix != "" {
		prompt = contextPrefix + prompt
	}

	reviewID, feedback, err := e.taskStore.GetPendingReview(taskID)
	if err != nil && err != sql.ErrNoRows {
		return fmt.Errorf("get pending review for task %s: %w", taskID, err)
	}
	if err == sql.ErrNoRows {
		reviewID = ""
		feedback = ""
	}

	var args []string
	if t.SessionID != "" && len(toolCfg.ResumeArgs) > 0 {
		args = buildResumeArgs(toolCfg, t.SessionID, feedback, model)
	} else {
		prompt = strings.TrimSpace(prompt) + "\n\nReviewer feedback: " + feedback
	}
	if e.budgetAwareEnabled() {
		prompt = strings.TrimSpace(prompts.BudgetAware) + "\n\n---\n\n" + prompt
	}
	prompt = strings.TrimSpace(prompts.OutputStyle) + "\n\n---\n\n" + prompt

	if err := e.taskStore.Update(taskID, map[string]interface{}{"status": "running"}); err != nil {
		return fmt.Errorf("set task running: %w", err)
	}
	if e.broadcastHook != nil {
		e.broadcastHook(taskID, "running")
	}

	defer func() {
		e.mu.Lock()
		delete(e.running, taskID)
		delete(e.sessions, taskID)
		e.mu.Unlock()
	}()
	defer func() {
		if r := recover(); r != nil {
			slog.Error("worker panic", "task_id", taskID, "panic", r)
			_ = e.taskStore.Update(taskID, map[string]interface{}{"status": "failed"})
			if e.broadcastHook != nil {
				e.broadcastHook(taskID, "failed")
			}
			e.emitDone(taskID, -1)
		}
	}()

	outputCh := make(chan worker.OutputLine, 256)
	outputDone := make(chan struct{})
	go e.captureOutput(outputCh, outputDone)

	info := taskInfo{
		taskID:       taskID,
		taskTitle:    t.Title,
		toolName:     toolName,
		toolCfg:      toolCfg,
		worktreePath: wtPath,
		prompt:       prompt,
		model:        model,
		args:         args,
	}

	result := e.runTask(ctx, info, outputCh)
	close(outputCh)
	<-outputDone
	e.emitDone(taskID, result.ExitCode)

	if err := e.taskStore.Update(taskID, map[string]interface{}{"status": result.Status}); err != nil {
		slog.Warn("update task status failed", "task_id", taskID, "status", result.Status, "err", err)
	}
	if e.broadcastHook != nil {
		e.broadcastHook(taskID, result.Status)
	}

	_, err = e.db.Exec(
		`INSERT INTO artifacts (id, task_id, run_id, diff, stdout, stderr, exit_code, duration_ms, quality_json)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		uuid.New().String(), taskID, runID,
		result.Diff, result.Stdout, result.Stderr, result.ExitCode, result.Duration.Milliseconds(), nil,
	)
	if err != nil {
		slog.Warn("store artifact failed", "task_id", taskID, "run_id", runID, "err", err)
	}
	if reviewID != "" && result.ExitCode == 0 {
		if err := e.taskStore.AddressReview(reviewID); err != nil {
			slog.Warn("address review failed", "review_id", reviewID, "task_id", taskID, "err", err)
		}
	}

	return nil
}

// Cancel stops all running workers.
func (e *Executor) Cancel() error {
	if e.cancel != nil {
		e.cancel()
	}

	e.mu.Lock()
	cmds := make(map[string]*exec.Cmd, len(e.running))
	for k, v := range e.running {
		cmds[k] = v
	}
	e.mu.Unlock()

	e.mu.Lock()
	sessionIDs := make(map[string]string, len(e.sessions))
	for taskID, sessionID := range e.sessions {
		sessionIDs[taskID] = sessionID
	}
	e.mu.Unlock()

	for taskID, cmd := range cmds {
		if e.sessionMgr != nil {
			if sessionID, ok := sessionIDs[taskID]; ok && sessionID != "" {
				slog.Info("closing PTY session", "task_id", taskID, "session_id", sessionID)
				if err := e.sessionMgr.Kill(sessionID); err != nil {
					slog.Warn("close PTY session failed", "session_id", sessionID, "task_id", taskID, "err", err)
				}
				continue
			}
		}
		if cmd.Process != nil {
			slog.Info("sending SIGINT to task", "task_id", taskID, "pid", cmd.Process.Pid)
			_ = cmd.Process.Signal(syscall.SIGINT)
		}
	}

	time.Sleep(5 * time.Second)

	e.mu.Lock()
	for taskID, cmd := range e.running {
		if _, ok := e.sessions[taskID]; ok {
			continue
		}
		if cmd.Process != nil {
			slog.Warn("force killing task", "task_id", taskID, "pid", cmd.Process.Pid)
			_ = cmd.Process.Kill()
		}
	}
	e.mu.Unlock()

	return nil
}

// rollbackPreparation cleans up worktrees created during prep and resets task state.
func (e *Executor) rollbackPreparation(taskIDs []string) {
	for _, taskID := range taskIDs {
		if err := e.worktrees.Remove(taskID); err != nil {
			slog.Warn("rollback remove worktree failed", "task_id", taskID, "err", err)
		}
		if err := e.taskStore.Update(taskID, map[string]interface{}{"status": "pending"}); err != nil {
			slog.Warn("rollback reset task failed", "task_id", taskID, "err", err)
		}
	}
}

// CleanupTasks removes worktrees for all tasks in the batch. Logs errors but
// continues cleanup for remaining tasks. Returns the first error encountered.
func (e *Executor) CleanupTasks(taskIDs []string) error {
	var firstErr error
	for _, taskID := range taskIDs {
		if err := e.worktrees.Remove(taskID); err != nil {
			slog.Warn("remove worktree failed", "task_id", taskID, "err", err)
			if firstErr == nil {
				firstErr = err
			}
		}
	}
	return firstErr
}

func (e *Executor) resolveTaskToolConfig(phase string) (string, config.ToolConfig, error) {
	return e.config.ResolveToolForPhase(phase, "")
}
