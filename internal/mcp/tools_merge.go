package mcp

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/jasjeetmavi/orca/internal/integrator"
)

func (s *Server) HandleMergeTool(_ json.RawMessage) (interface{}, error) {
	var sprintID string
	err := s.planner.DB().QueryRow(
		`SELECT id FROM sprints WHERE status IN ('completed', 'failed') ORDER BY completed_at DESC LIMIT 1`,
	).Scan(&sprintID)
	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("no completed sprint to merge")
	}
	if err != nil {
		return nil, err
	}

	sp, err := s.planner.Get(sprintID)
	if err != nil {
		return nil, err
	}

	taskIDs := make([]string, 0, len(sp.TaskIDs))
	for _, id := range sp.TaskIDs {
		t, err := s.planner.GetTask(id)
		if err == nil && t.Status == "approved" {
			taskIDs = append(taskIDs, id)
		}
	}
	if len(taskIDs) == 0 {
		return nil, fmt.Errorf("no approved tasks to merge")
	}

	ig := integrator.New(s.repoDir, s.cfg.Project.IntegrationBranch, s.cfg.Validation.Commands)
	merged, failed, err := ig.MergeBatch(taskIDs)
	if err != nil {
		return nil, err
	}

	for _, id := range merged {
		if err := s.store.Update(id, map[string]interface{}{"status": "merged"}); err != nil {
			return nil, fmt.Errorf("mark merged for %s: %w", id, err)
		}
		if err := s.executor.Worktrees().Remove(id); err != nil {
		}
	}

	if sprintID != "" {
		_, _ = s.planner.CompleteSprintIfDone(sprintID)
	}

	return map[string]interface{}{
		"sprint_id": sprintID,
		"merged":    merged,
		"failed":    failed,
	}, nil
}

func (s *Server) HandleTasksMergeTool(argsRaw json.RawMessage) (interface{}, error) {
	var args struct {
		TaskID string `json:"task_id"`
	}
	if err := json.Unmarshal(argsRaw, &args); err != nil {
		return nil, fmt.Errorf("tasks_merge args: %w", err)
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
	if t.Status != "approved" {
		return nil, fmt.Errorf("task %s is %q, only approved tasks can be merged", taskID, t.Status)
	}

	ig := integrator.New(s.repoDir, s.cfg.Project.IntegrationBranch, s.cfg.Validation.Commands)
	if err := ig.MergeAndValidate(taskID); err != nil {
		return nil, fmt.Errorf("merge task %s: %w", taskID, err)
	}
	if err := s.store.Update(taskID, map[string]interface{}{"status": "merged"}); err != nil {
		return nil, err
	}
	_ = s.executor.Worktrees().Remove(taskID)
	if t.SprintID != "" {
		_, _ = s.planner.CompleteSprintIfDone(t.SprintID)
	}
	return map[string]interface{}{"task_id": taskID, "status": "merged"}, nil
}
