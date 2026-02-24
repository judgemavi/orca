package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

func (s *Server) HandleTasksApproveTool(argsRaw json.RawMessage) (interface{}, error) {
	args, err := parseArgs[struct {
		TaskID string `json:"task_id"`
	}](argsRaw)
	if err != nil {
		return nil, fmt.Errorf("tasks_approve: %w", err)
	}
	if strings.TrimSpace(args.TaskID) == "" {
		return nil, fmt.Errorf("task_id is required")
	}

	taskID, err := s.taskStore.ResolveID(args.TaskID)
	if err != nil {
		return nil, err
	}

	t, err := s.taskStore.Get(taskID)
	if err != nil {
		return nil, err
	}
	if t.Status != "review" {
		return nil, fmt.Errorf("task must be in review status to approve")
	}

	if err := s.taskStore.Update(taskID, map[string]interface{}{"status": "approved"}); err != nil {
		return nil, err
	}
	return map[string]interface{}{"task_id": taskID, "status": "approved"}, nil
}

func (s *Server) HandleTasksRequestChangesTool(argsRaw json.RawMessage) (interface{}, error) {
	args, err := parseArgs[struct {
		TaskID   string `json:"task_id"`
		Feedback string `json:"feedback"`
	}](argsRaw)
	if err != nil {
		return nil, fmt.Errorf("tasks_request_changes: %w", err)
	}
	if strings.TrimSpace(args.TaskID) == "" {
		return nil, fmt.Errorf("task_id is required")
	}
	feedback := strings.TrimSpace(args.Feedback)
	if feedback == "" {
		return nil, fmt.Errorf("feedback is required")
	}

	taskID, err := s.taskStore.ResolveID(args.TaskID)
	if err != nil {
		return nil, err
	}
	t, err := s.taskStore.Get(taskID)
	if err != nil {
		return nil, err
	}
	if t.Status != "review" {
		return nil, fmt.Errorf("task must be in review status to request changes")
	}

	if _, err := s.taskStore.AddReview(taskID, feedback); err != nil {
		return nil, err
	}
	if err := s.taskStore.Update(taskID, map[string]interface{}{"status": "running"}); err != nil {
		return nil, err
	}

	if err := s.executor.RunSingle(context.Background(), taskID); err != nil {
		return nil, err
	}
	updated, err := s.taskStore.Get(taskID)
	if err != nil {
		return nil, err
	}
	return map[string]interface{}{"task_id": taskID, "status": updated.Status}, nil
}
