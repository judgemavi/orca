package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"

	"github.com/jasjeetmavi/orca/internal/review"
)

func (s *Server) HandleReviewGetTool(argsRaw json.RawMessage) (interface{}, error) {
	var args struct {
		SprintID string `json:"sprint_id"`
	}
	if err := json.Unmarshal(argsRaw, &args); err != nil {
		return nil, fmt.Errorf("review_get args: %w", err)
	}
	if strings.TrimSpace(args.SprintID) == "" {
		return nil, fmt.Errorf("sprint_id is required")
	}

	sp, err := s.planner.Get(args.SprintID)
	if err != nil {
		return nil, err
	}

	type artifact struct {
		TaskID     string   `json:"task_id"`
		Title      string   `json:"title"`
		Status     string   `json:"status"`
		Diff       string   `json:"diff,omitempty"`
		Files      []string `json:"files,omitempty"`
		Stdout     string   `json:"stdout,omitempty"`
		Stderr     string   `json:"stderr,omitempty"`
		ExitCode   *int     `json:"exit_code,omitempty"`
		DurationMs int64    `json:"duration_ms"`
	}

	artifacts := make([]artifact, 0, len(sp.TaskIDs))
	for _, taskID := range sp.TaskIDs {
		t, err := s.planner.GetTask(taskID)
		if err != nil {
			continue
		}

		a := artifact{TaskID: taskID, Title: t.Title, Status: t.Status}
		var diff, stdout, stderr string
		var exitCode int
		var durationMs int64
		artErr := s.planner.DB().QueryRow(
			`SELECT diff, stdout, stderr, exit_code, duration_ms FROM artifacts WHERE task_id = ? AND sprint_id = ? ORDER BY rowid DESC LIMIT 1`,
			taskID, args.SprintID,
		).Scan(&diff, &stdout, &stderr, &exitCode, &durationMs)

		if artErr == nil {
			a.Diff = diff
			a.Stdout = stdout
			a.Stderr = stderr
			a.ExitCode = &exitCode
			a.DurationMs = durationMs
			for _, line := range strings.Split(diff, "\n") {
				if strings.HasPrefix(line, "+++ b/") {
					a.Files = append(a.Files, strings.TrimPrefix(line, "+++ b/"))
				}
			}
		}
		artifacts = append(artifacts, a)
	}
	return map[string]interface{}{"sprint_id": args.SprintID, "artifacts": artifacts}, nil
}

func (s *Server) HandleReviewSprintTool(argsRaw json.RawMessage) (interface{}, error) {
	var args struct {
		SprintID string `json:"sprint_id"`
	}
	if err := json.Unmarshal(argsRaw, &args); err != nil {
		return nil, fmt.Errorf("review_sprint args: %w", err)
	}
	if strings.TrimSpace(args.SprintID) == "" {
		return nil, fmt.Errorf("sprint_id is required")
	}

	sp, err := s.planner.Get(args.SprintID)
	if err != nil {
		return nil, err
	}

	reviewers := make(map[string]*review.Reviewer)
	results := make([]review.ReviewResult, 0, len(sp.TaskIDs))
	for _, taskID := range sp.TaskIDs {
		t, err := s.planner.GetTask(taskID)
		if err != nil || t.Status != "approved" {
			continue
		}

		var diff string
		if err := s.planner.DB().QueryRow(
			`SELECT diff FROM artifacts WHERE task_id = ? AND sprint_id = ?`,
			taskID, args.SprintID,
		).Scan(&diff); err != nil || strings.TrimSpace(diff) == "" {
			continue
		}

		toolName, toolCfg, err := s.cfg.ResolveToolForPhase(t, "review", "")
		if err != nil {
			results = append(results, review.ReviewResult{
				TaskID:   taskID,
				Approved: false,
				Feedback: fmt.Sprintf("review tool resolution error: %v", err),
			})
			continue
		}

		key := toolName + "\x00" + toolCfg.Model
		reviewer, ok := reviewers[key]
		if !ok {
			reviewer = review.New(toolCfg, s.repoDir)
			reviewers[key] = reviewer
		}

		res, err := reviewer.Review(taskID, t.Title, t.Description, diff)
		if err != nil {
			results = append(results, review.ReviewResult{
				TaskID:   taskID,
				Approved: false,
				Feedback: fmt.Sprintf("review error: %v", err),
				Tool:     toolCfg.Binary,
			})
			continue
		}
		results = append(results, *res)
	}
	return map[string]interface{}{"sprint_id": args.SprintID, "results": results}, nil
}

func (s *Server) HandleTasksApproveTool(argsRaw json.RawMessage) (interface{}, error) {
	var args struct {
		TaskID string `json:"task_id"`
	}
	if err := json.Unmarshal(argsRaw, &args); err != nil {
		return nil, fmt.Errorf("tasks_approve args: %w", err)
	}
	if strings.TrimSpace(args.TaskID) == "" {
		return nil, fmt.Errorf("task_id is required")
	}

	taskID, err := s.store.ResolveID(args.TaskID)
	if err != nil {
		return nil, err
	}

	t, err := s.store.Get(taskID)
	if err != nil {
		return nil, err
	}
	if t.Status != "review" {
		return nil, fmt.Errorf("task must be in review status to approve")
	}

	if err := s.store.Update(taskID, map[string]interface{}{"status": "approved"}); err != nil {
		return nil, err
	}
	if t.SprintID != "" {
		if _, err := s.planner.CompleteSprintIfDone(t.SprintID); err != nil {
			slog.Warn("check sprint completion after approve failed", "sprint_id", t.SprintID, "err", err)
		}
	}
	return map[string]interface{}{"task_id": taskID, "status": "approved"}, nil
}

func (s *Server) HandleTasksRequestChangesTool(argsRaw json.RawMessage) (interface{}, error) {
	var args struct {
		TaskID   string `json:"task_id"`
		Feedback string `json:"feedback"`
	}
	if err := json.Unmarshal(argsRaw, &args); err != nil {
		return nil, fmt.Errorf("tasks_request_changes args: %w", err)
	}
	if strings.TrimSpace(args.TaskID) == "" {
		return nil, fmt.Errorf("task_id is required")
	}
	feedback := strings.TrimSpace(args.Feedback)
	if feedback == "" {
		return nil, fmt.Errorf("feedback is required")
	}

	taskID, err := s.store.ResolveID(args.TaskID)
	if err != nil {
		return nil, err
	}
	t, err := s.store.Get(taskID)
	if err != nil {
		return nil, err
	}
	if t.Status != "review" {
		return nil, fmt.Errorf("task must be in review status to request changes")
	}

	if _, err := s.store.AddReview(taskID, feedback); err != nil {
		return nil, err
	}
	if err := s.store.Update(taskID, map[string]interface{}{"status": "running"}); err != nil {
		return nil, err
	}

	if err := s.executor.RunSingle(context.Background(), taskID); err != nil {
		return nil, err
	}
	updated, err := s.store.Get(taskID)
	if err != nil {
		return nil, err
	}
	return map[string]interface{}{"task_id": taskID, "status": updated.Status}, nil
}
