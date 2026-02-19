package sprint

import (
	"context"
	"fmt"
	"log"
	"os/exec"
	"sync"
	"syscall"
	"time"

	"github.com/google/uuid"
	"github.com/jasjeetmavi/pod/internal/config"
	"github.com/jasjeetmavi/pod/internal/cost"
	"github.com/jasjeetmavi/pod/internal/explore"
	"github.com/jasjeetmavi/pod/internal/worker"
	"github.com/jasjeetmavi/pod/internal/worktree"
)

// TaskResult holds the outcome of a single task execution.
type TaskResult struct {
	TaskID       string
	ToolName     string
	Status       string // "completed" or "failed"
	ExitCode     int
	Diff         string
	FilesChanged []string
	Stdout       string
	Stderr       string
	Duration     time.Duration
	WorktreePath string
}

// Executor orchestrates sprint execution: worktree creation, parallel worker
// spawning, result collection, and artifact storage.
type Executor struct {
	planner   *Planner
	worktrees *worktree.Manager
	config    *config.Config
	repoDir   string

	// Cost tracking (optional — nil means no tracking).
	costTracker *cost.Tracker

	// Cancel support.
	cancel   context.CancelFunc
	mu       sync.Mutex
	running  map[string]*exec.Cmd
	sprintID string // set during Run for Cancel to reference
}

// NewExecutor creates an Executor wired to the given planner, worktree manager,
// config, and repo directory.
func NewExecutor(planner *Planner, wm *worktree.Manager, cfg *config.Config, repoDir string) *Executor {
	return &Executor{
		planner:   planner,
		worktrees: wm,
		config:    cfg,
		repoDir:   repoDir,
		running:   make(map[string]*exec.Cmd),
	}
}

// SetCostTracker sets the cost tracker for recording per-task spend.
func (e *Executor) SetCostTracker(ct *cost.Tracker) { e.costTracker = ct }

// Worktrees returns the underlying worktree manager.
func (e *Executor) Worktrees() *worktree.Manager { return e.worktrees }

// Run executes all tasks in a sprint: transitions to running, creates worktrees,
// runs workers in parallel, collects results, updates task statuses, stores artifacts.
func (e *Executor) Run(s *Sprint) ([]TaskResult, error) {
	if err := e.planner.Start(s.ID); err != nil {
		return nil, fmt.Errorf("start sprint: %w", err)
	}

	// Set up cancellable context for all workers.
	ctx, cancel := context.WithCancel(context.Background())
	e.cancel = cancel
	e.sprintID = s.ID

	type taskInfo struct {
		taskID       string
		toolName     string
		toolCfg      config.ToolConfig
		worktreePath string
		prompt       string
	}

	// Load codebase context if available.
	contextPrefix := ""
	if cctx := explore.LoadContext(e.repoDir); cctx != "" {
		contextPrefix = "## Codebase Context\n\n" + cctx + "\n\n---\n\n"
	}

	var prepared []taskInfo
	var createdTaskIDs []string
	for _, taskID := range s.TaskIDs {
		t, err := e.planner.GetTask(taskID)
		if err != nil {
			e.rollbackPreparation(s, createdTaskIDs)
			return nil, fmt.Errorf("get task %s: %w", taskID, err)
		}

		toolName, toolCfg, err := e.resolveToolConfig(t.AssignedTool)
		if err != nil {
			e.rollbackPreparation(s, createdTaskIDs)
			return nil, fmt.Errorf("resolve tool for task %s: %w", taskID, err)
		}

		wtPath, _, err := e.worktrees.Create(taskID, e.config.Project.IntegrationBranch)
		if err != nil {
			e.rollbackPreparation(s, createdTaskIDs)
			return nil, fmt.Errorf("create worktree for task %s: %w", taskID, err)
		}
		createdTaskIDs = append(createdTaskIDs, taskID)

		prompt := t.Prompt
		if prompt == "" {
			prompt = t.Title + "\n\n" + t.Description
		}
		if contextPrefix != "" {
			prompt = contextPrefix + prompt
		}

		prepared = append(prepared, taskInfo{
			taskID:       taskID,
			toolName:     toolName,
			toolCfg:      toolCfg,
			worktreePath: wtPath,
			prompt:       prompt,
		})
	}

	// Run all workers in parallel. Each goroutine writes to its own index,
	// so no mutex needed on the results slice.
	results := make([]TaskResult, len(prepared))
	var wg sync.WaitGroup

	for i, ti := range prepared {
		wg.Add(1)
		go func(idx int, info taskInfo) {
			defer wg.Done()
			defer func() {
				e.mu.Lock()
				delete(e.running, info.taskID)
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
				}
			}()

			workerAdapter, err := worker.NewWorker(info.toolCfg)
			if err != nil {
				results[idx] = TaskResult{
					TaskID:       info.taskID,
					ToolName:     info.toolName,
					Status:       "failed",
					ExitCode:     -1,
					Stderr:       fmt.Sprintf("create adapter: %v", err),
					WorktreePath: info.worktreePath,
				}
				return
			}

			// Register running cmd for cancel tracking.
			workerAdapter.SetCmdCallback(func(cmd *exec.Cmd) {
				e.mu.Lock()
				e.running[info.taskID] = cmd
				e.mu.Unlock()
			})

			res, err := workerAdapter.Execute(ctx, info.taskID, info.prompt, info.worktreePath)
			if err != nil {
				results[idx] = TaskResult{
					TaskID:       info.taskID,
					ToolName:     info.toolName,
					Status:       "failed",
					ExitCode:     -1,
					Stderr:       fmt.Sprintf("execute: %v", err),
					WorktreePath: info.worktreePath,
				}
				return
			}

			status := "completed"
			if res.ExitCode != 0 {
				status = "failed"
			}

			results[idx] = TaskResult{
				TaskID:       info.taskID,
				ToolName:     info.toolName,
				Status:       status,
				ExitCode:     res.ExitCode,
				Diff:         res.Diff,
				FilesChanged: res.FilesChanged,
				Stdout:       res.Stdout,
				Stderr:       res.Stderr,
				Duration:     res.Duration,
				WorktreePath: info.worktreePath,
			}
		}(i, ti)
	}

	wg.Wait()

	// Update task statuses and store artifacts.
	for _, r := range results {
		if err := e.planner.CompleteTask(s.ID, r.TaskID, r.Status); err != nil {
			log.Printf("complete task %s: %v", r.TaskID, err)
		}

		_, err := e.planner.db.Exec(
			`INSERT INTO artifacts (id, task_id, sprint_id, diff, stdout, stderr, exit_code, duration_ms)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			uuid.New().String(), r.TaskID, s.ID,
			r.Diff, r.Stdout, r.Stderr, r.ExitCode, r.Duration.Milliseconds(),
		)
		if err != nil {
			log.Printf("store artifact for task %s: %v", r.TaskID, err)
		}

		if e.costTracker != nil {
			in, out, c, _ := cost.ParseClaudeCost(r.Stdout)
			if in > 0 || out > 0 || c > 0 {
				if err := e.costTracker.Record(s.ID, r.TaskID, r.ToolName, in, out, c); err != nil {
					log.Printf("record cost for task %s: %v", r.TaskID, err)
				}
			}
		}
	}

	return results, nil
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

	for taskID, cmd := range cmds {
		if cmd.Process != nil {
			log.Printf("sending SIGINT to task %s (pid %d)", taskID, cmd.Process.Pid)
			_ = cmd.Process.Signal(syscall.SIGINT)
		}
	}

	// Grace period — wait 5s then force kill any survivors.
	time.Sleep(5 * time.Second)

	e.mu.Lock()
	for taskID, cmd := range e.running {
		if cmd.Process != nil {
			log.Printf("force killing task %s (pid %d)", taskID, cmd.Process.Pid)
			_ = cmd.Process.Kill()
		}
	}
	e.mu.Unlock()

	return nil
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

// resolveToolConfig returns the tool name and ToolConfig for the named tool,
// or the first available tool in config if name is empty.
func (e *Executor) resolveToolConfig(name string) (string, config.ToolConfig, error) {
	if name != "" {
		tc, ok := e.config.Tools[name]
		if !ok {
			return "", config.ToolConfig{}, fmt.Errorf("tool %q not found in config", name)
		}
		return name, tc, nil
	}
	for n, tc := range e.config.Tools {
		return n, tc, nil
	}
	return "", config.ToolConfig{}, fmt.Errorf("no tools configured")
}
