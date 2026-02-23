package sprint

import (
	"bufio"
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
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

// Executor orchestrates sprint execution: worktree creation, parallel worker
// spawning, result collection, and artifact storage.
type Executor struct {
	planner    *Planner
	worktrees  *worktree.Manager
	config     *config.Config
	repoDir    string
	sessionMgr *pty.SessionManager

	// Cost tracking (optional — nil means no tracking).
	costTracker *cost.Tracker
	// Runtime monitors.
	monitorStuck    *monitor.StuckDetector
	monitorBudget   *monitor.BudgetEnforcer
	monitorConflict *monitor.ConflictDetector

	// Cancel support.
	cancel   context.CancelFunc
	runCtx   context.Context
	mu       sync.Mutex
	running  map[string]*exec.Cmd
	sessions map[string]string
	sprintID string // set during Run for Cancel to reference

	outputHook func(worker.OutputLine)
	doneHook   func(taskID string, exitCode int)

	// Optional task status broadcast callback (e.g. WS event emitter).
	broadcastHook func(taskID, status string)
	monitorHook   func(alertType, taskID, message string)

	// Run-scoped quality baseline used during artifact storage.
	runBaselineSnapshot *quality.Snapshot
}

// NewExecutor creates an Executor wired to the given planner, worktree manager,
// config, and repo directory.
func NewExecutor(planner *Planner, wm *worktree.Manager, cfg *config.Config, repoDir string, opts ExecutorOptions, sessionMgr ...*pty.SessionManager) *Executor {
	var mgr *pty.SessionManager
	if len(sessionMgr) > 0 {
		mgr = sessionMgr[0]
	}
	return &Executor{
		planner:       planner,
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

// Run executes all tasks in a sprint: transitions to running, creates worktrees,
// runs workers in parallel, collects results, updates task statuses, stores artifacts.
func (e *Executor) Run(s *Sprint) ([]TaskResult, error) {
	if err := e.worktrees.EnsureIntegrationBranch(e.config.Project.IntegrationBranch); err != nil {
		return nil, fmt.Errorf("ensure integration branch: %w", err)
	}
	if err := e.planner.Start(s.ID); err != nil {
		return nil, fmt.Errorf("start sprint: %w", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	e.cancel = cancel
	e.runCtx = ctx
	e.sprintID = s.ID
	defer func() { e.runCtx = nil }()
	contextPrefix := ""
	if cctx := explore.LoadContext(e.repoDir); cctx != "" {
		contextPrefix = "## Codebase Context\n\n" + cctx + "\n\n---\n\n"
	}
	prepared, createdTaskIDs, err := e.prepareSprintTasks(s, contextPrefix)
	if err != nil {
		e.rollbackPreparation(s, createdTaskIDs)
		return nil, err
	}
	monCancel := e.startMonitors(ctx, createdTaskIDs)
	defer monCancel()
	baselineSnapshot := e.takeBaselineSnapshot()
	e.runBaselineSnapshot = baselineSnapshot
	defer func() { e.runBaselineSnapshot = nil }()
	var wg sync.WaitGroup
	outputCh := make(chan worker.OutputLine, 4096)
	results := e.collectResults(prepared, outputCh, &wg, baselineSnapshot)
	e.storeArtifacts(s.ID, results)
	e.recordCosts(s.ID, prepared, results)
	if err := e.finalizeSprint(s.ID, results); err != nil {
		return results, err
	}
	return results, nil
}

func (e *Executor) prepareSprintTasks(s *Sprint, contextPrefix string) ([]taskInfo, []string, error) {
	prepared := make([]taskInfo, 0, len(s.TaskIDs))
	createdTaskIDs := make([]string, 0, len(s.TaskIDs))

	for _, taskID := range s.TaskIDs {
		t, err := e.planner.GetTask(taskID)
		if err != nil {
			return nil, createdTaskIDs, fmt.Errorf("get task %s: %w", taskID, err)
		}

		toolName, toolCfg, err := e.resolveTaskToolConfig(t, "sprint")
		if err != nil {
			return nil, createdTaskIDs, fmt.Errorf("resolve tool for task %s: %w", taskID, err)
		}
		model := toolCfg.Model

		wtPath, _, err := e.worktrees.Create(taskID, e.config.Project.IntegrationBranch)
		if err != nil {
			return nil, createdTaskIDs, fmt.Errorf("create worktree for task %s: %w", taskID, err)
		}
		createdTaskIDs = append(createdTaskIDs, taskID)

		prompt := t.Prompt
		if prompt == "" {
			prompt = t.Title + "\n\n" + t.Description
		}
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

func (e *Executor) startMonitors(ctx context.Context, taskIDs []string) context.CancelFunc {
	monCtx, monCancel := context.WithCancel(ctx)

	stuckCheckInterval := 30 * time.Second
	if raw := strings.TrimSpace(e.config.Monitor.StuckCheckInterval); raw != "" {
		if parsed, err := time.ParseDuration(raw); err != nil {
			log.Printf("monitor: invalid stuck_check_interval %q, using 30s: %v", raw, err)
		} else {
			stuckCheckInterval = parsed
		}
	}

	maxStuckCycles := e.config.Monitor.MaxStuckCycles
	if maxStuckCycles == 0 {
		maxStuckCycles = 3
	}

	conflictInterval := 15 * time.Second
	if raw := strings.TrimSpace(e.config.Monitor.ConflictInterval); raw != "" {
		if parsed, err := time.ParseDuration(raw); err != nil {
			log.Printf("monitor: invalid conflict_check_interval %q, using 15s: %v", raw, err)
		} else {
			conflictInterval = parsed
		}
	}

	e.monitorStuck = monitor.NewStuckDetector(
		e.config.Project.WorktreeDir,
		stuckCheckInterval,
		maxStuckCycles,
		func(taskID, reason string) {
			log.Printf("monitor: task %s stuck: %s", taskID, reason)
			e.emitMonitorAlert("stuck", taskID, reason)
			e.killTask(taskID)
		},
	)
	e.monitorStuck.Start(monCtx, taskIDs)

	e.monitorBudget = nil
	if (e.config.Orchestrator.CostBudget > 0 || e.config.Monitor.TaskBudget > 0) && e.costTracker != nil && len(taskIDs) > 0 {
		taskBudget := e.config.Monitor.TaskBudget
		if taskBudget <= 0 {
			taskBudget = e.config.Orchestrator.CostBudget / float64(len(taskIDs))
		}
		e.monitorBudget = monitor.NewBudgetEnforcer(
			stuckCheckInterval,
			taskBudget,
			e.config.Orchestrator.CostBudget,
			func(taskID string) float64 {
				var total sql.NullFloat64
				if err := e.planner.DB().QueryRow(
					`SELECT SUM(estimated_cost) FROM costs WHERE sprint_id = ? AND task_id = ?`,
					e.sprintID, taskID,
				).Scan(&total); err != nil {
					log.Printf("monitor: query cost for task %s: %v", taskID, err)
					return 0
				}
				if !total.Valid {
					return 0
				}
				return total.Float64
			},
			func(taskID string, spent, limit float64) {
				msg := fmt.Sprintf("budget exceeded ($%.2f/$%.2f)", spent, limit)
				log.Printf("monitor: task %s %s", taskID, msg)
				e.emitMonitorAlert("budget", taskID, msg)
				e.killTask(taskID)
			},
		)
		e.monitorBudget.Start(monCtx, taskIDs)
	}

	e.monitorConflict = monitor.NewConflictDetector(
		e.config.Project.WorktreeDir,
		conflictInterval,
		func(taskIDs, files []string) {
			msg := fmt.Sprintf("conflict detected between %v on files %v", taskIDs, files)
			log.Printf("monitor: %s", msg)
			for _, taskID := range taskIDs {
				e.emitMonitorAlert("conflict", taskID, msg)
			}
		},
	)
	e.monitorConflict.Start(monCtx, taskIDs)

	return monCancel
}

func (e *Executor) collectResults(prepared []taskInfo, outputCh chan worker.OutputLine, wg *sync.WaitGroup, baselineSnapshot *quality.Snapshot) []TaskResult {
	_ = baselineSnapshot

	results := make([]TaskResult, len(prepared))
	runCtx := e.runCtx
	if runCtx == nil {
		runCtx = context.Background()
	}
	outputDone := make(chan struct{})
	go func() {
		defer close(outputDone)
		ticker := time.NewTicker(100 * time.Millisecond)
		defer ticker.Stop()

		batch := make([]worker.OutputLine, 0, 128)
		flush := func() {
			if e.outputHook == nil || len(batch) == 0 {
				batch = batch[:0]
				return
			}
			for _, line := range batch {
				e.outputHook(line)
			}
			batch = batch[:0]
		}

		for {
			select {
			case line, ok := <-outputCh:
				if !ok {
					flush()
					return
				}
				batch = append(batch, line)
			case <-ticker.C:
				flush()
			}
		}
	}()

	for i, ti := range prepared {
		wg.Add(1)
		go func(idx int, info taskInfo) {
			defer wg.Done()
			defer func() {
				e.mu.Lock()
				delete(e.running, info.taskID)
				delete(e.sessions, info.taskID)
				e.mu.Unlock()

				if r := recover(); r != nil {
					log.Printf("worker panic for task %s: %v", info.taskID, r)
					results[idx] = TaskResult{
						TaskID:       info.taskID,
						ToolName:     info.toolName,
						Status:       "failed",
						ExitCode:     -1,
						Stderr:       fmt.Sprintf("worker panic: %v", r),
						WorktreePath: info.worktreePath,
					}
					e.emitDone(info.taskID, -1)
				}
			}()

			var taskResult TaskResult
			if e.sessionMgr != nil {
				taskResult = e.executeTaskPTY(runCtx, info, outputCh)
			} else {
				taskResult = e.executeTaskLegacy(runCtx, info, outputCh)
			}
			results[idx] = taskResult
			e.emitDone(info.taskID, taskResult.ExitCode)
		}(i, ti)
	}

	wg.Wait()
	close(outputCh)
	<-outputDone
	return results
}

func (e *Executor) takeBaselineSnapshot() *quality.Snapshot {
	if !e.config.Quality.Enabled || !e.config.Quality.TestDelta || len(e.config.Validation.Commands) == 0 {
		return nil
	}

	baselineSnapshot, err := quality.TakeSnapshot(e.repoDir, e.config.Validation.Commands)
	if err != nil {
		log.Printf("quality: baseline snapshot failed: %v", err)
		return nil
	}
	return baselineSnapshot
}

func (e *Executor) buildQualityJSON(r TaskResult) sql.NullString {
	if r.Status != "review" || !e.config.Quality.Enabled {
		return sql.NullString{}
	}

	var qualityPayload struct {
		Scope     *quality.ScopeAnalysis `json:"scope,omitempty"`
		TestDelta *quality.Delta         `json:"test_delta,omitempty"`
	}
	hasQualityData := false

	if e.config.Quality.ScopeCheck {
		taskTitle := ""
		if t, err := e.planner.GetTask(r.TaskID); err == nil {
			taskTitle = t.Title
		}
		scope := quality.AnalyzeScope(r.TaskID, taskTitle, r.Diff)
		qualityPayload.Scope = scope
		hasQualityData = true
		if scope.Excessive {
			log.Printf("quality: task %s scope creep: %v", r.TaskID, scope.Flags)
		}
	}

	if e.config.Quality.TestDelta && e.runBaselineSnapshot != nil && r.WorktreePath != "" {
		afterSnapshot, err := quality.TakeSnapshot(r.WorktreePath, e.config.Validation.Commands)
		if err != nil {
			log.Printf("quality: task %s post snapshot failed: %v", r.TaskID, err)
		} else if afterSnapshot != nil {
			delta := quality.ComputeDelta(e.runBaselineSnapshot, afterSnapshot)
			qualityPayload.TestDelta = delta
			hasQualityData = true
			if len(delta.NewFailures) > 0 {
				log.Printf("quality: task %s broke tests: %v", r.TaskID, delta.NewFailures)
			}
		}
	}

	if !hasQualityData {
		return sql.NullString{}
	}

	buf, err := json.Marshal(qualityPayload)
	if err != nil {
		log.Printf("quality: task %s marshal failed: %v", r.TaskID, err)
		return sql.NullString{}
	}
	return sql.NullString{String: string(buf), Valid: true}
}

func (e *Executor) storeArtifacts(sprintID string, results []TaskResult) {
	for _, r := range results {
		qualityJSON := e.buildQualityJSON(r)
		_, err := e.planner.db.Exec(
			`INSERT INTO artifacts (id, task_id, sprint_id, diff, stdout, stderr, exit_code, duration_ms, quality_json)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			uuid.New().String(), r.TaskID, sprintID,
			r.Diff, r.Stdout, r.Stderr, r.ExitCode, r.Duration.Milliseconds(), qualityJSON,
		)
		if err != nil {
			log.Printf("store artifact for task %s: %v", r.TaskID, err)
		}
	}
}

func (e *Executor) recordCosts(sprintID string, prepared []taskInfo, results []TaskResult) {
	if e.costTracker == nil {
		return
	}

	costCfgByTaskID := make(map[string]config.ToolCostConfig, len(prepared))
	for _, info := range prepared {
		costCfgByTaskID[info.taskID] = info.toolCfg.Cost
	}

	for _, r := range results {
		in, out, c, err := cost.ParseCost(costCfgByTaskID[r.TaskID], r.Stdout)
		if err != nil {
			log.Printf("parse cost for task %s: %v", r.TaskID, err)
		}
		if in > 0 || out > 0 || c > 0 {
			if err := e.costTracker.Record(sprintID, r.TaskID, r.ToolName, in, out, c); err != nil {
				log.Printf("record cost for task %s: %v", r.TaskID, err)
			}
		}
	}
}

func (e *Executor) finalizeSprint(sprintID string, results []TaskResult) error {
	for _, r := range results {
		if err := e.planner.CompleteTask(sprintID, r.TaskID, r.Status); err != nil {
			log.Printf("complete task %s: %v", r.TaskID, err)
		}
	}

	return e.planner.CompleteSprintIfDone(sprintID)
}

func (e *Executor) executeTaskLegacy(ctx context.Context, info taskInfo, outputCh chan<- worker.OutputLine) TaskResult {
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
		e.mu.Lock()
		e.running[info.taskID] = cmd
		e.mu.Unlock()
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

func (e *Executor) executeTaskPTY(ctx context.Context, info taskInfo, outputCh chan<- worker.OutputLine) TaskResult {
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

	e.mu.Lock()
	e.running[info.taskID] = sess.Cmd
	e.sessions[info.taskID] = sess.ID
	e.mu.Unlock()

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
			log.Printf("kill PTY session %s for task %s: %v", sess.ID, info.taskID, err)
		}
	}()

	start := time.Now()
	stdout, streamErr := streamSessionPTY(info.taskID, sess.Pty, outputCh)
	close(readDone)
	result.Duration = time.Since(start)
	result.Stdout = stdout

	if streamErr != nil && !errorsIsEOF(streamErr) {
		log.Printf("stream PTY (%s): %v", info.taskID, streamErr)
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
		log.Printf("set session_id for task %s: %v", taskID, err)
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

func streamSessionPTY(taskID string, r io.Reader, outputCh chan<- worker.OutputLine) (string, error) {
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

	t, err := e.planner.GetTask(taskID)
	if err != nil {
		return fmt.Errorf("get task %s: %w", taskID, err)
	}

	toolName, toolCfg, err := e.resolveTaskToolConfig(t, "sprint")
	if err != nil {
		return fmt.Errorf("resolve tool for task %s: %w", taskID, err)
	}
	model := toolCfg.Model

	wtPath := filepath.Join(e.config.Project.WorktreeDir, "task-"+taskID)
	if _, err := os.Stat(wtPath); err != nil {
		if !os.IsNotExist(err) {
			return fmt.Errorf("stat worktree for task %s: %w", taskID, err)
		}
		createdPath, _, err := e.worktrees.Create(taskID, e.config.Project.IntegrationBranch)
		if err != nil {
			return fmt.Errorf("create worktree for task %s: %w", taskID, err)
		}
		wtPath = createdPath
	}

	contextPrefix := ""
	if cctx := explore.LoadContext(e.repoDir); cctx != "" {
		contextPrefix = "## Codebase Context\n\n" + cctx + "\n\n---\n\n"
	}

	prompt := t.Prompt
	if prompt == "" {
		prompt = t.Title + "\n\n" + t.Description
	}
	if t.Plan != "" {
		prompt = "## Implementation Plan\n\n" + t.Plan + "\n\n---\n\n## Task\n\n" + prompt
	}
	if contextPrefix != "" {
		prompt = contextPrefix + prompt
	}

	taskStore := task.NewStore(e.planner.DB())
	reviewID, feedback, err := taskStore.GetPendingReview(taskID)
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

	if err := taskStore.Update(taskID, map[string]interface{}{"status": "running"}); err != nil {
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
			log.Printf("worker panic for task %s: %v", taskID, r)
			_ = taskStore.Update(taskID, map[string]interface{}{"status": "failed"})
			if e.broadcastHook != nil {
				e.broadcastHook(taskID, "failed")
			}
			e.emitDone(taskID, -1)
		}
	}()

	outputCh := make(chan worker.OutputLine, 256)
	outputDone := make(chan struct{})
	go func() {
		defer close(outputDone)
		for line := range outputCh {
			if e.outputHook != nil {
				e.outputHook(line)
			}
		}
	}()

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

	var result TaskResult
	if e.sessionMgr != nil {
		result = e.executeTaskPTY(ctx, info, outputCh)
	} else {
		result = e.executeTaskLegacy(ctx, info, outputCh)
	}
	close(outputCh)
	<-outputDone
	e.emitDone(taskID, result.ExitCode)

	if err := taskStore.Update(taskID, map[string]interface{}{"status": result.Status}); err != nil {
		log.Printf("update task status %s: %v", taskID, err)
	}
	if e.broadcastHook != nil {
		e.broadcastHook(taskID, result.Status)
	}

	if t.SprintID != "" {
		_, err := e.planner.DB().Exec(
			`INSERT INTO artifacts (id, task_id, sprint_id, diff, stdout, stderr, exit_code, duration_ms, quality_json)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			uuid.New().String(), taskID, t.SprintID,
			result.Diff, result.Stdout, result.Stderr, result.ExitCode, result.Duration.Milliseconds(), nil,
		)
		if err != nil {
			log.Printf("store artifact for task %s: %v", taskID, err)
		}
	}
	if reviewID != "" && result.ExitCode == 0 {
		if err := taskStore.AddressReview(reviewID); err != nil {
			log.Printf("address review %s for task %s: %v", reviewID, taskID, err)
		}
	}

	return nil
}

// Cancel stops all running workers.
func (e *Executor) Cancel() error {
	// Cancel the context to signal all workers.
	if e.cancel != nil {
		e.cancel()
	}

	// Send SIGINT to all running processes for graceful shutdown.
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
				log.Printf("closing PTY session for task %s (%s)", taskID, sessionID)
				if err := e.sessionMgr.Kill(sessionID); err != nil {
					log.Printf("close PTY session %s for task %s: %v", sessionID, taskID, err)
				}
				continue
			}
		}
		if cmd.Process != nil {
			log.Printf("sending SIGINT to task %s (pid %d)", taskID, cmd.Process.Pid)
			_ = cmd.Process.Signal(syscall.SIGINT)
		}
	}

	// Grace period — wait 5s then force kill any survivors.
	time.Sleep(5 * time.Second)

	e.mu.Lock()
	for taskID, cmd := range e.running {
		if _, ok := e.sessions[taskID]; ok {
			continue
		}
		if cmd.Process != nil {
			log.Printf("force killing task %s (pid %d)", taskID, cmd.Process.Pid)
			_ = cmd.Process.Kill()
		}
	}
	e.mu.Unlock()

	return nil
}

func (e *Executor) killTask(taskID string) {
	e.mu.Lock()
	cmd, ok := e.running[taskID]
	sessionID := e.sessions[taskID]
	e.mu.Unlock()
	if e.sessionMgr != nil && sessionID != "" {
		if err := e.sessionMgr.Kill(sessionID); err != nil {
			log.Printf("kill PTY session %s for task %s: %v", sessionID, taskID, err)
		}
		return
	}
	if ok && cmd != nil && cmd.Process != nil {
		_ = cmd.Process.Signal(syscall.SIGINT)
	}
}

// rollbackPreparation cleans up worktrees created during prep and resets task/sprint state.
func (e *Executor) rollbackPreparation(s *Sprint, createdTaskIDs []string) {
	for _, taskID := range createdTaskIDs {
		if err := e.worktrees.Remove(taskID); err != nil {
			log.Printf("rollback: remove worktree for task %s: %v", taskID, err)
		}
	}
	if err := e.planner.ResetSprintTasks(s.ID); err != nil {
		log.Printf("rollback: reset sprint tasks: %v", err)
	}
	if err := e.planner.Fail(s.ID); err != nil {
		log.Printf("rollback: fail sprint: %v", err)
	}
}

// Cleanup removes worktrees for all tasks in the sprint. Logs errors but
// continues cleanup for remaining tasks. Returns the first error encountered.
func (e *Executor) Cleanup(s *Sprint) error {
	var firstErr error
	for _, taskID := range s.TaskIDs {
		if err := e.worktrees.Remove(taskID); err != nil {
			log.Printf("remove worktree for task %s: %v", taskID, err)
			if firstErr == nil {
				firstErr = err
			}
		}
	}
	return firstErr
}

// resolveTaskToolConfig resolves tool and model for a task phase with fallback:
// phase_config.phases[phase] -> assigned_tool -> config phase/default chain.
func (e *Executor) resolveTaskToolConfig(t *task.Task, phase string) (string, config.ToolConfig, error) {
	var phaseCfg *task.PhaseOverride
	if t != nil && t.PhaseConfig != nil && !t.PhaseConfig.UseDefaults {
		if p, ok := t.PhaseConfig.Phases[phase]; ok {
			phaseCfg = &p
		}
	}

	var (
		toolName string
		toolCfg  config.ToolConfig
	)
	if phaseCfg != nil && phaseCfg.Tool != "" {
		if tc, ok := e.config.Tools[phaseCfg.Tool]; ok {
			toolName = phaseCfg.Tool
			toolCfg = tc
		} else {
			log.Printf("task phase_config tool %q for phase %q not found in config, falling back", phaseCfg.Tool, phase)
		}
	}
	if toolName == "" && t != nil && t.AssignedTool != "" {
		if tc, ok := e.config.Tools[t.AssignedTool]; ok {
			toolName = t.AssignedTool
			toolCfg = tc
		} else {
			log.Printf("task assigned_tool %q not found in config, falling back to %s phase default", t.AssignedTool, phase)
		}
	}
	if toolName == "" {
		var err error
		toolName, toolCfg, err = e.config.ResolvePhaseToolConfig(phase)
		if err != nil {
			return "", config.ToolConfig{}, err
		}
	}

	if phaseCfg != nil {
		if model := e.validateModel(toolName, phaseCfg.Model, toolCfg); model != "" {
			toolCfg.Model = model
			return toolName, toolCfg, nil
		}
	}
	if t != nil {
		if model := e.validateModel(toolName, t.Model, toolCfg); model != "" {
			toolCfg.Model = model
			return toolName, toolCfg, nil
		}
	}

	if _, phaseToolCfg, err := e.config.ResolvePhaseToolConfig(phase); err == nil {
		if model := e.validateModel(toolName, phaseToolCfg.Model, toolCfg); model != "" {
			toolCfg.Model = model
		}
	}
	return toolName, toolCfg, nil
}

func (e *Executor) validateModel(toolName, model string, toolCfg config.ToolConfig) string {
	if model == "" {
		return ""
	}
	for _, m := range toolCfg.Models {
		if m == model {
			return model
		}
	}
	log.Printf("task model %q not in %s models list, using default", model, toolName)
	return ""
}
