package executor

// Package executor orchestrates parallel task execution: worktree creation,
// worker spawning, result collection, and artifact storage.
//
// Depends on: worker, driver, interaction, monitor, worktree, quality
// Consumed by: orchestrator, API handlers
// Key flow: RunBatch → prepareTasks → collectResult → finalizeRun

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jasjeetmavi/orca/internal/config"
	"github.com/jasjeetmavi/orca/internal/driver"
	"github.com/jasjeetmavi/orca/internal/explore"
	"github.com/jasjeetmavi/orca/internal/interaction"
	"github.com/jasjeetmavi/orca/internal/monitor"
	"github.com/jasjeetmavi/orca/internal/pty"
	"github.com/jasjeetmavi/orca/internal/quality"
	"github.com/jasjeetmavi/orca/internal/state"
	"github.com/jasjeetmavi/orca/internal/task"
	"github.com/jasjeetmavi/orca/internal/worker"
	"github.com/jasjeetmavi/orca/internal/worktree"
	"github.com/jasjeetmavi/orca/prompts"
)

var runnableTaskStatuses = map[string]bool{
	"pending": true,
	"planned": true,
	"failed":  true,
	"review":  true,
}

// TaskResult holds the outcome of a single task execution.
type TaskResult struct {
	TaskID       string        `json:"task_id"`
	ToolName     string        `json:"tool_name"`
	Model        string        `json:"model,omitempty"`
	Status       string        `json:"status"` // "review" or "failed"
	ExitCode     int           `json:"exit_code"`
	Diff         string        `json:"diff,omitempty"`
	FilesChanged []string      `json:"files_changed,omitempty"`
	Stdout       string        `json:"stdout,omitempty"`
	Stderr       string        `json:"stderr,omitempty"`
	InputTokens  int64         `json:"input_tokens,omitempty"`
	OutputTokens int64         `json:"output_tokens,omitempty"`
	TotalCost    float64       `json:"total_cost,omitempty"`
	Duration     time.Duration `json:"duration"`
	WorktreePath string        `json:"worktree_path,omitempty"`
}

type RunOpts struct {
	ToolOverride  string
	ModelOverride string
}

type taskInfo struct {
	taskID          string
	taskTitle       string
	toolName        string
	driver          driver.Driver
	timeout         time.Duration
	logWriter       *interaction.Writer
	worktreePath    string
	prompt          string
	model           string
	args            []string
	resumeSessionID string
	resumeFeedback  string
}

// ExecutorOptions configures optional executor dependencies and callbacks.
type ExecutorOptions struct {
	Interactions  *interaction.Store
	OutputHook    func(worker.OutputLine)
	DoneHook      func(taskID string, exitCode int)
	BroadcastHook func(taskID, status string)
}

// Executor orchestrates task execution: worktree creation, parallel worker
// spawning, result collection, and artifact storage.
type Executor struct {
	parentCtx  context.Context
	db         *state.DB
	taskStore  *task.Store
	worktrees  *worktree.Manager
	config     *config.Config
	repoDir    string
	sessionMgr *pty.SessionManager

	// Interaction tracking (optional — nil means no tracking).
	interactions *interaction.Store
	// Runtime monitors.
	monitors []monitor.Monitor

	// Stop support.
	cancel   context.CancelFunc
	runCtx   context.Context
	mu       sync.Mutex
	running  map[string]*exec.Cmd
	sessions map[string]string
	stopped  map[string]bool // tasks explicitly stopped by user
	runID    string          // ephemeral, set during RunBatch

	outputHook func(worker.OutputLine)
	doneHook   func(taskID string, exitCode int)

	// Optional task status broadcast callback (e.g. WS event emitter).
	broadcastHook func(taskID, status string)
	monitorHook   func(alertType, taskID, message string)

	// Run-scoped quality baseline used during artifact storage.
	runBaselineSnapshot *quality.Snapshot
}

// --- private helpers ---

func (e *Executor) prepareTasks(taskIDs []string, contextPrefix string, opts RunOpts) ([]taskInfo, []string, error) {
	prepared := make([]taskInfo, 0, len(taskIDs))
	createdTaskIDs := make([]string, 0, len(taskIDs))

	for _, taskID := range taskIDs {
		t, err := e.taskStore.Get(taskID)
		if err != nil {
			return nil, createdTaskIDs, fmt.Errorf("get task %s: %w", taskID, err)
		}

		toolName, d, err := e.resolveTaskToolConfig(interaction.PhaseRun, opts.ToolOverride)
		if err != nil {
			e.closePreparedWriters(prepared)
			return nil, createdTaskIDs, fmt.Errorf("resolve tool for task %s: %w", taskID, err)
		}
		model := e.config.ResolveModelForPhase(interaction.PhaseRun, opts.ModelOverride, d)
		timeout := 10 * time.Minute
		if parsed, parseErr := time.ParseDuration("600s"); parseErr == nil {
			timeout = parsed
		}

		wtPath := worktree.ResolveTaskDir(e.config.Project.WorktreeDir, taskID)
		if _, statErr := os.Stat(wtPath); os.IsNotExist(statErr) {
			created, _, createErr := e.worktrees.Create(taskID, e.config.Project.IntegrationBranch, t.Title)
			if createErr != nil {
				e.closePreparedWriters(prepared)
				return nil, createdTaskIDs, fmt.Errorf("create worktree for task %s: %w", taskID, createErr)
			}
			wtPath = created
			createdTaskIDs = append(createdTaskIDs, taskID)
		}

		prompt := t.Title + "\n\n" + t.Description
		if t.Plan != "" {
			prompt = "## Implementation Plan\n\n" + t.Plan + "\n\n---\n\n## Task\n\n" + prompt
		}
		if contextPrefix != "" {
			prompt = contextPrefix + prompt
		}
		prompt = strings.TrimSpace(prompts.OutputStyle) + "\n\n" + strings.TrimSpace(prompts.ExecutorStyle) + "\n\n---\n\n" + prompt

		var writer *interaction.Writer
		if e.interactions != nil {
			taskRef := taskID
			w, beginErr := e.interactions.Begin(&taskRef, interaction.PhaseRun, toolName)
			if beginErr != nil {
				slog.Warn("begin interaction failed", "task_id", taskID, "err", beginErr)
			} else {
				writer = w
			}
		}

		prepared = append(prepared, taskInfo{
			taskID:       taskID,
			taskTitle:    t.Title,
			toolName:     toolName,
			driver:       d,
			timeout:      timeout,
			logWriter:    writer,
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
		if e.wasStopped(r.TaskID) {
			continue
		}
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

// rollbackPreparation cleans up worktrees created during prep and resets task state.
func (e *Executor) rollbackPreparation(taskIDs []string) {
	for _, taskID := range taskIDs {
		if err := e.worktrees.Remove(taskID); err != nil {
			slog.Warn("rollback remove worktree failed", "task_id", taskID, "err", err)
		}
		if err := e.taskStore.Update(taskID, map[string]interface{}{"status": "planned"}); err != nil {
			slog.Warn("rollback reset task failed", "task_id", taskID, "err", err)
		}
	}
}

func (e *Executor) closePreparedWriters(prepared []taskInfo) {
	for _, info := range prepared {
		if info.logWriter != nil {
			_ = info.logWriter.Close()
		}
	}
}

func (e *Executor) resolveTaskToolConfig(phase string, override string) (string, driver.Driver, error) {
	return e.config.ResolveToolForPhase(phase, override)
}

// --- exported functions/methods ---

// NewExecutor creates an Executor wired to DB, task store, worktree manager,
// config, and repo directory.
func NewExecutor(parentCtx context.Context, db *state.DB, taskStore *task.Store, wm *worktree.Manager, cfg *config.Config, repoDir string, opts ExecutorOptions, sessionMgr ...*pty.SessionManager) *Executor {
	if parentCtx == nil {
		parentCtx = context.Background()
	}

	var mgr *pty.SessionManager
	if len(sessionMgr) > 0 {
		mgr = sessionMgr[0]
	}
	return &Executor{
		parentCtx:     parentCtx,
		db:            db,
		taskStore:     taskStore,
		worktrees:     wm,
		config:        cfg,
		repoDir:       repoDir,
		sessionMgr:    mgr,
		running:       make(map[string]*exec.Cmd),
		sessions:      make(map[string]string),
		stopped:       make(map[string]bool),
		interactions:  opts.Interactions,
		outputHook:    opts.OutputHook,
		doneHook:      opts.DoneHook,
		broadcastHook: opts.BroadcastHook,
	}
}

func (e *Executor) newRunContext() (context.Context, context.CancelFunc) {
	parentCtx := e.parentCtx
	if parentCtx == nil {
		parentCtx = context.Background()
	}
	return context.WithCancel(parentCtx)
}

// Worktrees returns the underlying worktree manager.
func (e *Executor) Worktrees() *worktree.Manager { return e.worktrees }

// StopTask interrupts a currently running task process.
func (e *Executor) StopTask(taskID string) error {
	e.mu.Lock()
	_, ok := e.running[taskID]
	if !ok {
		e.mu.Unlock()
		return fmt.Errorf("task not running")
	}
	e.stopped[taskID] = true
	e.mu.Unlock()
	e.killProcess(taskID)
	return nil
}

// wasStopped checks and clears the stopped flag for a task.
func (e *Executor) wasStopped(taskID string) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.stopped[taskID] {
		delete(e.stopped, taskID)
		return true
	}
	return false
}

// SetMonitorAlertHook sets a callback for runtime monitor alerts.
func (e *Executor) SetMonitorAlertHook(fn func(alertType, taskID, message string)) {
	e.monitorHook = fn
}

// RunBatch executes all tasks in a batch: transitions to running, creates worktrees,
// runs workers in parallel, collects results, updates task statuses, stores artifacts.
func (e *Executor) RunBatch(taskIDs []string, opts RunOpts) ([]TaskResult, error) {
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
		t, err := e.taskStore.Get(id)
		if err != nil {
			return nil, fmt.Errorf("get task %s: %w", id, err)
		}
		if !runnableTaskStatuses[t.Status] {
			return nil, fmt.Errorf("task %s must be pending or planned to run (current: %s)", id, t.Status)
		}

		if err := e.taskStore.Update(id, map[string]interface{}{"status": "running"}); err != nil {
			return nil, fmt.Errorf("set task %s running: %w", id, err)
		}
		if e.broadcastHook != nil {
			e.broadcastHook(id, "running")
		}
	}

	runID := uuid.New().String()
	e.runID = runID
	ctx, cancel := e.newRunContext()
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

	prepared, _, err := e.prepareTasks(taskIDs, contextPrefix, opts)
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
	e.finishRunInteractions(runID, prepared, results)
	if err := e.finalizeRun(results); err != nil {
		return results, err
	}
	return results, nil
}

type resumeRunState struct {
	reviewID        string
	feedback        string
	args            []string
	resumeSessionID string
}

func (e *Executor) resolveResumeRunState(taskID, sessionID string, d driver.Driver, model, worktreePath string, requireSession bool) (resumeRunState, error) {
	reviewID, feedback, err := e.taskStore.GetPendingReview(taskID)
	if err != nil && err != sql.ErrNoRows {
		return resumeRunState{}, fmt.Errorf("get pending review for task %s: %w", taskID, err)
	}
	if err == sql.ErrNoRows {
		reviewID = ""
		feedback = ""
	}

	if requireSession && sessionID == "" {
		return resumeRunState{}, fmt.Errorf("task %s cannot resume without session_id", taskID)
	}

	var args []string
	resumeSessionID := ""
	if sessionID != "" {
		args = d.ResumeArgs(sessionID, feedback, model, worktreePath)
		resumeSessionID = sessionID
	}

	return resumeRunState{
		reviewID:        reviewID,
		feedback:        feedback,
		args:            args,
		resumeSessionID: resumeSessionID,
	}, nil
}

func (e *Executor) runSingleWithOpts(ctx context.Context, taskID string, opts RunOpts, requireStopped bool) (*TaskResult, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	runID := uuid.New().String()

	t, err := e.taskStore.Get(taskID)
	if err != nil {
		return nil, fmt.Errorf("get task %s: %w", taskID, err)
	}
	if requireStopped && t.Status != "stopped" {
		return nil, fmt.Errorf("task %s is %q, only stopped tasks can be resumed", taskID, t.Status)
	}
	if requireStopped && t.SessionID == "" {
		return nil, fmt.Errorf("task %s cannot resume without session_id", taskID)
	}

	toolName, d, err := e.resolveTaskToolConfig(interaction.PhaseRun, opts.ToolOverride)
	if err != nil {
		return nil, fmt.Errorf("resolve tool for task %s: %w", taskID, err)
	}
	model := e.config.ResolveModelForPhase(interaction.PhaseRun, opts.ModelOverride, d)
	timeout, _ := time.ParseDuration("600s")

	wtPath := worktree.ResolveTaskDir(e.config.Project.WorktreeDir, taskID)
	if _, err := os.Stat(wtPath); err != nil {
		if !os.IsNotExist(err) {
			return nil, fmt.Errorf("stat worktree for task %s: %w", taskID, err)
		}
		createdPath, _, err := e.worktrees.Create(taskID, e.config.Project.IntegrationBranch, t.Title)
		if err != nil {
			return nil, fmt.Errorf("create worktree for task %s: %w", taskID, err)
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

	resumeState, err := e.resolveResumeRunState(taskID, t.SessionID, d, model, wtPath, requireStopped)
	if err != nil {
		return nil, err
	}
	runPhase := interaction.PhaseRun
	if resumeState.reviewID != "" {
		runPhase = interaction.PhaseRevise
	}
	if resumeState.resumeSessionID == "" && strings.TrimSpace(resumeState.feedback) != "" {
		prompt = strings.TrimSpace(prompt) + "\n\nReviewer feedback: " + resumeState.feedback
	}
	prompt = strings.TrimSpace(prompts.OutputStyle) + "\n\n" + strings.TrimSpace(prompts.ExecutorStyle) + "\n\n---\n\n" + prompt

	if err := e.taskStore.Update(taskID, map[string]interface{}{"status": "running"}); err != nil {
		return nil, fmt.Errorf("set task running: %w", err)
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
	var writer *interaction.Writer
	if e.interactions != nil {
		taskRef := taskID
		w, beginErr := e.interactions.Begin(&taskRef, runPhase, toolName)
		if beginErr != nil {
			slog.Warn("begin interaction failed", "task_id", taskID, "run_id", runID, "err", beginErr)
		} else {
			writer = w
			if runPhase == interaction.PhaseRevise && strings.TrimSpace(resumeState.feedback) != "" {
				_ = writer.WriteString("Reviewer feedback:\n" + resumeState.feedback + "\n\n")
			}
		}
	}
	go e.captureOutput(outputCh, outputDone, map[string]*interaction.Writer{taskID: writer})

	info := taskInfo{
		taskID:          taskID,
		taskTitle:       t.Title,
		toolName:        toolName,
		driver:          d,
		timeout:         timeout,
		worktreePath:    wtPath,
		prompt:          prompt,
		model:           model,
		args:            resumeState.args,
		resumeSessionID: resumeState.resumeSessionID,
		resumeFeedback:  resumeState.feedback,
	}

	result := e.runTask(ctx, info, outputCh)
	close(outputCh)
	<-outputDone
	e.emitDone(taskID, result.ExitCode)

	if !e.wasStopped(taskID) {
		if err := e.taskStore.Update(taskID, map[string]interface{}{"status": result.Status}); err != nil {
			slog.Warn("update task status failed", "task_id", taskID, "status", result.Status, "err", err)
		}
		if e.broadcastHook != nil {
			e.broadcastHook(taskID, result.Status)
		}
	}

	if e.interactions != nil && writer != nil {
		status := "completed"
		if result.Status == "failed" {
			status = "failed"
		}
		opts := []interaction.FinishOption{
			interaction.WithRunID(runID),
			interaction.WithModel(model),
			interaction.WithDiff(result.Diff),
			interaction.WithExitCode(result.ExitCode),
			interaction.WithDuration(result.Duration),
			interaction.WithCost(result.InputTokens, result.OutputTokens, result.TotalCost),
		}
		if result.Stderr != "" && status == "failed" {
			opts = append(opts, interaction.WithError(result.Stderr))
		}
		if finishErr := e.interactions.Finish(writer.ID(), status, opts...); finishErr != nil {
			slog.Warn("finish interaction failed", "task_id", taskID, "run_id", runID, "err", finishErr)
		}
		if closeErr := writer.Close(); closeErr != nil {
			slog.Warn("close interaction failed", "task_id", taskID, "run_id", runID, "err", closeErr)
		}
	}
	if resumeState.reviewID != "" && result.ExitCode == 0 {
		if err := e.taskStore.AddressReview(resumeState.reviewID); err != nil {
			slog.Warn("address review failed", "review_id", resumeState.reviewID, "task_id", taskID, "err", err)
		}
	}

	return &result, nil
}

// RunSingleWithOpts re-runs a single task with optional tool/model overrides.
func (e *Executor) RunSingleWithOpts(ctx context.Context, taskID string, opts RunOpts) error {
	_, err := e.runSingleWithOpts(ctx, taskID, opts, false)
	return err
}

// ResumeTask resumes a stopped task from its saved session.
func (e *Executor) ResumeTask(taskID string) (*TaskResult, error) {
	return e.runSingleWithOpts(context.Background(), taskID, RunOpts{}, true)
}
