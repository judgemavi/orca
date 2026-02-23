package mcp

import (
	"encoding/json"
	"fmt"
	"strings"
)

func (s *Server) HandleTasksListTool(argsRaw json.RawMessage) (interface{}, error) {
	var args struct {
		Status string `json:"status"`
	}
	if err := json.Unmarshal(argsRaw, &args); err != nil {
		return nil, fmt.Errorf("tasks_list args: %w", err)
	}

	if args.Status != "" {
		tasks, err := s.store.ListByStatus(args.Status)
		if err != nil {
			return nil, err
		}
		return map[string]interface{}{"tasks": tasks}, nil
	}

	tasks, err := s.store.List()
	if err != nil {
		return nil, err
	}
	return map[string]interface{}{"tasks": tasks}, nil
}

func (s *Server) HandleTasksCreateTool(argsRaw json.RawMessage) (interface{}, error) {
	var args struct {
		Title        string   `json:"title"`
		Description  string   `json:"description"`
		AssignedTool string   `json:"assigned_tool"`
		Model        string   `json:"model"`
		DependsOn    []string `json:"depends_on"`
	}
	if err := json.Unmarshal(argsRaw, &args); err != nil {
		return nil, fmt.Errorf("tasks_create args: %w", err)
	}
	if strings.TrimSpace(args.Title) == "" {
		return nil, fmt.Errorf("title is required")
	}

	t, err := s.store.Create(args.Title, args.Description, "", args.AssignedTool)
	if err != nil {
		return nil, err
	}

	for _, dep := range args.DependsOn {
		resolved, err := s.store.ResolveID(dep)
		if err != nil {
			_ = s.store.Delete(t.ID)
			return nil, fmt.Errorf("resolve dependency %q: %w", dep, err)
		}
		if err := s.store.AddDependency(t.ID, resolved); err != nil {
			_ = s.store.Delete(t.ID)
			return nil, fmt.Errorf("add dependency %q: %w", resolved, err)
		}
	}

	if args.Model != "" {
		if err := s.store.Update(t.ID, map[string]interface{}{"model": args.Model}); err != nil {
			return nil, fmt.Errorf("set model: %w", err)
		}
	}

	created, err := s.store.Get(t.ID)
	if err != nil {
		return nil, err
	}
	return map[string]interface{}{"task": created}, nil
}

func (s *Server) HandleTasksUpdateTool(argsRaw json.RawMessage) (interface{}, error) {
	var args struct {
		TaskID       string  `json:"task_id"`
		Title        *string `json:"title"`
		Description  *string `json:"description"`
		Status       *string `json:"status"`
		AssignedTool *string `json:"assigned_tool"`
		Model        *string `json:"model"`
		Prompt       *string `json:"prompt"`
	}
	if err := json.Unmarshal(argsRaw, &args); err != nil {
		return nil, fmt.Errorf("tasks_update args: %w", err)
	}
	if strings.TrimSpace(args.TaskID) == "" {
		return nil, fmt.Errorf("task_id is required")
	}

	resolved, err := s.store.ResolveID(args.TaskID)
	if err != nil {
		return nil, err
	}

	fields := make(map[string]interface{})
	if args.Title != nil {
		fields["title"] = *args.Title
	}
	if args.Description != nil {
		fields["description"] = *args.Description
	}
	if args.Status != nil {
		fields["status"] = *args.Status
	}
	if args.AssignedTool != nil {
		fields["assigned_tool"] = *args.AssignedTool
	}
	if args.Model != nil {
		fields["model"] = *args.Model
	}
	if args.Prompt != nil {
		fields["prompt"] = *args.Prompt
	}

	if len(fields) > 0 {
		if err := s.store.Update(resolved, fields); err != nil {
			return nil, err
		}
	}

	updated, err := s.store.Get(resolved)
	if err != nil {
		return nil, err
	}
	return map[string]interface{}{"task": updated}, nil
}

func (s *Server) HandleTasksGetTool(argsRaw json.RawMessage) (interface{}, error) {
	var args struct {
		TaskID string `json:"task_id"`
	}
	if err := json.Unmarshal(argsRaw, &args); err != nil {
		return nil, fmt.Errorf("tasks_get args: %w", err)
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
	return map[string]interface{}{"task": t}, nil
}

func (s *Server) HandleTasksDeleteTool(argsRaw json.RawMessage) (interface{}, error) {
	var args struct {
		TaskID string `json:"task_id"`
	}
	if err := json.Unmarshal(argsRaw, &args); err != nil {
		return nil, fmt.Errorf("tasks_delete args: %w", err)
	}
	if strings.TrimSpace(args.TaskID) == "" {
		return nil, fmt.Errorf("task_id is required")
	}
	taskID, err := s.store.ResolveID(args.TaskID)
	if err != nil {
		return nil, err
	}
	tk, err := s.store.Get(taskID)
	if err != nil {
		return nil, err
	}
	sprintID := tk.SprintID
	if err := s.store.Delete(taskID); err != nil {
		return nil, err
	}
	_ = s.executor.Worktrees().Remove(taskID)
	if sprintID != "" {
		_, _ = s.planner.CompleteSprintIfDone(sprintID)
	}
	return map[string]interface{}{"task_id": taskID, "deleted": true}, nil
}

func (s *Server) HandleTasksReopenTool(argsRaw json.RawMessage) (interface{}, error) {
	var args struct {
		TaskID string `json:"task_id"`
	}
	if err := json.Unmarshal(argsRaw, &args); err != nil {
		return nil, fmt.Errorf("tasks_reopen args: %w", err)
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
	if t.Status != "failed" {
		return nil, fmt.Errorf("task %s is %q, only failed tasks can be reopened", taskID, t.Status)
	}
	if err := s.store.Update(taskID, map[string]interface{}{"status": "pending", "sprint_id": nil}); err != nil {
		return nil, err
	}
	return map[string]interface{}{"task_id": taskID, "status": "pending"}, nil
}

func (s *Server) HandleTasksAddDependencyTool(argsRaw json.RawMessage) (interface{}, error) {
	var args struct {
		TaskID    string `json:"task_id"`
		DependsOn string `json:"depends_on"`
	}
	if err := json.Unmarshal(argsRaw, &args); err != nil {
		return nil, fmt.Errorf("tasks_add_dependency args: %w", err)
	}
	taskID, err := s.store.ResolveID(args.TaskID)
	if err != nil {
		return nil, fmt.Errorf("resolve task: %w", err)
	}
	depID, err := s.store.ResolveID(args.DependsOn)
	if err != nil {
		return nil, fmt.Errorf("resolve dependency: %w", err)
	}
	if err := s.store.AddDependency(taskID, depID); err != nil {
		return nil, err
	}
	return map[string]interface{}{"task_id": taskID, "depends_on": depID}, nil
}
