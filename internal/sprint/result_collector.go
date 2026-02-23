package sprint

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jasjeetmavi/orca/internal/config"
	"github.com/jasjeetmavi/orca/internal/cost"
	"github.com/jasjeetmavi/orca/internal/quality"
	"github.com/jasjeetmavi/orca/internal/worker"
)

func (e *Executor) collectResult(prepared []taskInfo, baselineSnapshot *quality.Snapshot) []TaskResult {
	_ = baselineSnapshot

	results := make([]TaskResult, len(prepared))
	maxParallel := e.config.Workers.MaxParallel
	if maxParallel <= 0 {
		maxParallel = 1
	}
	sem := make(chan struct{}, maxParallel)
	runCtx := e.runCtx
	if runCtx == nil {
		runCtx = context.Background()
	}

	outputCh := make(chan worker.OutputLine, 4096)
	outputDone := make(chan struct{})
	go e.captureOutput(outputCh, outputDone)

	var wg sync.WaitGroup
	for i, ti := range prepared {
		wg.Add(1)
		go func(idx int, info taskInfo) {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
			case <-runCtx.Done():
				results[idx] = TaskResult{
					TaskID:       info.taskID,
					ToolName:     info.toolName,
					Status:       "failed",
					ExitCode:     -1,
					Stderr:       "orca: process cancelled",
					WorktreePath: info.worktreePath,
				}
				e.emitDone(info.taskID, -1)
				return
			}
			defer func() { <-sem }()
			defer func() {
				e.mu.Lock()
				delete(e.running, info.taskID)
				delete(e.sessions, info.taskID)
				e.mu.Unlock()

				if r := recover(); r != nil {
					slog.Error("worker panic", "task_id", info.taskID, "panic", r)
					results[idx] = TaskResult{
						TaskID:       info.taskID,
						ToolName:     info.toolName,
						Status:       "failed",
						ExitCode:     -1,
						Stderr:       fmt.Sprintf("worker panic: %v", r),
						WorktreePath: info.worktreePath,
					}
					slog.Info("task.completed", "task_id", info.taskID, "status", results[idx].Status, "exit_code", results[idx].ExitCode, "duration", results[idx].Duration)
					e.emitDone(info.taskID, -1)
				}
			}()

			slog.Info("task.started", "task_id", info.taskID, "tool", info.toolName, "sprint_id", e.sprintID)
			taskResult := e.runTask(runCtx, info, outputCh)
			results[idx] = taskResult
			slog.Info("task.completed", "task_id", info.taskID, "status", taskResult.Status, "exit_code", taskResult.ExitCode, "duration", taskResult.Duration)
			e.emitDone(info.taskID, taskResult.ExitCode)
		}(i, ti)
	}

	wg.Wait()
	close(outputCh)
	<-outputDone
	return results
}

func (e *Executor) captureOutput(outputCh <-chan worker.OutputLine, done chan<- struct{}) {
	defer close(done)
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
}

func (e *Executor) takeBaselineSnapshot() *quality.Snapshot {
	if !e.config.Quality.Enabled || !e.config.Quality.TestDelta || len(e.config.Validation.Commands) == 0 {
		return nil
	}

	baselineSnapshot, err := quality.TakeSnapshot(e.repoDir, e.config.Validation.Commands)
	if err != nil {
		slog.Warn("quality baseline snapshot failed", "err", err)
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
			slog.Warn("quality scope creep", "task_id", r.TaskID, "flags", scope.Flags)
		}
	}

	if e.config.Quality.TestDelta && e.runBaselineSnapshot != nil && r.WorktreePath != "" {
		afterSnapshot, err := quality.TakeSnapshot(r.WorktreePath, e.config.Validation.Commands)
		if err != nil {
			slog.Warn("quality post snapshot failed", "task_id", r.TaskID, "err", err)
		} else if afterSnapshot != nil {
			delta := quality.ComputeDelta(e.runBaselineSnapshot, afterSnapshot)
			qualityPayload.TestDelta = delta
			hasQualityData = true
			if len(delta.NewFailures) > 0 {
				slog.Warn("quality new test failures", "task_id", r.TaskID, "new_failures", delta.NewFailures)
			}
		}
	}

	if !hasQualityData {
		return sql.NullString{}
	}

	buf, err := json.Marshal(qualityPayload)
	if err != nil {
		slog.Warn("quality marshal failed", "task_id", r.TaskID, "err", err)
		return sql.NullString{}
	}
	return sql.NullString{String: string(buf), Valid: true}
}

func (e *Executor) storeArtifacts(sprintID string, results []TaskResult) {
	for _, r := range results {
		qualityJSON := e.buildQualityJSON(r)
		_, err := e.planner.DB().Exec(
			`INSERT INTO artifacts (id, task_id, sprint_id, diff, stdout, stderr, exit_code, duration_ms, quality_json)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			uuid.New().String(), r.TaskID, sprintID,
			r.Diff, r.Stdout, r.Stderr, r.ExitCode, r.Duration.Milliseconds(), qualityJSON,
		)
		if err != nil {
			slog.Warn("store artifact failed", "task_id", r.TaskID, "err", err)
		}
	}
}

func (e *Executor) recordCost(sprintID string, prepared []taskInfo, results []TaskResult) {
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
			slog.Warn("parse cost failed", "task_id", r.TaskID, "err", err)
		}
		if in > 0 || out > 0 || c > 0 {
			if err := e.costTracker.Record(sprintID, r.TaskID, r.ToolName, in, out, c); err != nil {
				slog.Warn("record cost failed", "task_id", r.TaskID, "sprint_id", sprintID, "err", err)
			}
		}
	}
}
