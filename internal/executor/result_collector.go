package executor

// result_collector.go fans out task execution across workers, captures output,
// and assembles TaskResult slices for the caller.
//
// Called by: RunBatch
// Key flow: collectResult → parallel runTask → captureOutput → finishRunInteractions

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/jasjeetmavi/orca/internal/interaction"
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
	go e.captureOutput(outputCh, outputDone, preparedWriters(prepared))

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

			slog.Info("task.started", "task_id", info.taskID, "tool", info.toolName, "run_id", e.runID)
			taskResult := e.runTask(runCtx, info, outputCh)
			taskResult.Model = info.model
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

func (e *Executor) captureOutput(outputCh <-chan worker.OutputLine, done chan<- struct{}, writers map[string]*interaction.Writer) {
	defer close(done)
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()

	batch := make([]worker.OutputLine, 0, 128)
	flush := func() {
		if len(batch) == 0 {
			batch = batch[:0]
			return
		}
		for _, line := range batch {
			if w := writers[line.TaskID]; w != nil && line.Stream == "raw" {
				_ = w.WriteString(line.Line + "\n")
			}
			if e.outputHook != nil {
				e.outputHook(line)
			}
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
		if t, err := e.taskStore.Get(r.TaskID); err == nil {
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

func preparedWriters(prepared []taskInfo) map[string]*interaction.Writer {
	writers := make(map[string]*interaction.Writer, len(prepared))
	for _, info := range prepared {
		if info.logWriter != nil {
			writers[info.taskID] = info.logWriter
		}
	}
	return writers
}

func (e *Executor) finishRunInteractions(runID string, prepared []taskInfo, results []TaskResult) {
	if e.interactions == nil {
		return
	}

	for i, r := range results {
		if i >= len(prepared) {
			continue
		}
		info := prepared[i]
		if info.logWriter == nil {
			continue
		}

		status := "completed"
		if r.Status == "failed" {
			status = "failed"
		}
		opts := []interaction.FinishOption{
			interaction.WithRunID(runID),
			interaction.WithModel(r.Model),
			interaction.WithExitCode(r.ExitCode),
			interaction.WithDuration(r.Duration),
			interaction.WithDiff(r.Diff),
			interaction.WithCost(r.InputTokens, r.OutputTokens, r.TotalCost),
		}
		if r.Stderr != "" && status == "failed" {
			opts = append(opts, interaction.WithError(r.Stderr))
		}
		if qualityJSON := e.buildQualityJSON(r); qualityJSON.Valid {
			opts = append(opts, interaction.WithQuality(qualityJSON.String))
		}
		if err := e.interactions.Finish(info.logWriter.ID(), status, opts...); err != nil {
			slog.Warn("finish interaction failed", "task_id", r.TaskID, "err", err)
		}
		if err := info.logWriter.Close(); err != nil {
			slog.Warn("close interaction log failed", "task_id", r.TaskID, "err", err)
		}
	}
}
