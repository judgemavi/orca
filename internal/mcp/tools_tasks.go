package mcp

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/jasjeetmavi/orca/internal/executor"
	"github.com/jasjeetmavi/orca/internal/task"
)

func (s *Server) HandleTasksListTool(argsRaw json.RawMessage) (interface{}, error) {
	args, err := parseArgs[struct {
		Status string `json:"status"`
	}](argsRaw)
	if err != nil {
		return nil, fmt.Errorf("tasks_list: %w", err)
	}

	if args.Status != "" {
		tasks, err := s.taskStore.ListByStatus(args.Status)
		if err != nil {
			return nil, err
		}
		return map[string]interface{}{"tasks": tasks}, nil
	}

	tasks, err := s.taskStore.List()
	if err != nil {
		return nil, err
	}
	return map[string]interface{}{"tasks": tasks}, nil
}

func (s *Server) HandleTasksCreateTool(argsRaw json.RawMessage) (interface{}, error) {
	args, err := parseArgs[struct {
		Title       string   `json:"title"`
		Description string   `json:"description"`
		DependsOn   []string `json:"depends_on"`
	}](argsRaw)
	if err != nil {
		return nil, fmt.Errorf("tasks_create: %w", err)
	}
	if strings.TrimSpace(args.Title) == "" {
		return nil, fmt.Errorf("title is required")
	}

	t, err := s.taskStore.Create(args.Title, args.Description, "")
	if err != nil {
		return nil, err
	}

	for _, dep := range args.DependsOn {
		resolved, err := s.taskStore.ResolveID(dep)
		if err != nil {
			_ = s.taskStore.Delete(t.ID)
			return nil, fmt.Errorf("resolve dependency %q: %w", dep, err)
		}
		if err := s.taskStore.AddDependency(t.ID, resolved); err != nil {
			_ = s.taskStore.Delete(t.ID)
			return nil, fmt.Errorf("add dependency %q: %w", resolved, err)
		}
	}

	created, err := s.taskStore.Get(t.ID)
	if err != nil {
		return nil, err
	}
	return map[string]interface{}{"task": created}, nil
}

func (s *Server) HandleTasksUpdateTool(argsRaw json.RawMessage) (interface{}, error) {
	args, err := parseArgs[struct {
		TaskID      string  `json:"task_id"`
		Title       *string `json:"title"`
		Description *string `json:"description"`
		Status      *string `json:"status"`
		Plan        *string `json:"plan"`
	}](argsRaw)
	if err != nil {
		return nil, fmt.Errorf("tasks_update: %w", err)
	}
	if strings.TrimSpace(args.TaskID) == "" {
		return nil, fmt.Errorf("task_id is required")
	}

	resolved, err := s.taskStore.ResolveID(args.TaskID)
	if err != nil {
		return nil, err
	}

	fields := task.UpdateFields{}
	hasUpdates := false
	if args.Title != nil {
		fields.Title = task.Ptr(*args.Title)
		hasUpdates = true
	}
	if args.Description != nil {
		fields.Description = task.Ptr(*args.Description)
		hasUpdates = true
	}
	if args.Status != nil {
		fields.Status = task.Ptr(*args.Status)
		hasUpdates = true
	}
	if args.Plan != nil {
		fields.Plan = task.Ptr(*args.Plan)
		hasUpdates = true
	}

	if hasUpdates {
		if err := s.taskStore.Update(resolved, fields); err != nil {
			return nil, err
		}
	}

	updated, err := s.taskStore.Get(resolved)
	if err != nil {
		return nil, err
	}
	return map[string]interface{}{"task": updated}, nil
}

func (s *Server) HandleTasksGetTool(argsRaw json.RawMessage) (interface{}, error) {
	args, err := parseArgs[struct {
		TaskID string `json:"task_id"`
	}](argsRaw)
	if err != nil {
		return nil, fmt.Errorf("tasks_get: %w", err)
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
	return map[string]interface{}{"task": t}, nil
}

func (s *Server) HandleTasksDeleteTool(argsRaw json.RawMessage) (interface{}, error) {
	args, err := parseArgs[struct {
		TaskID string `json:"task_id"`
	}](argsRaw)
	if err != nil {
		return nil, fmt.Errorf("tasks_delete: %w", err)
	}
	if strings.TrimSpace(args.TaskID) == "" {
		return nil, fmt.Errorf("task_id is required")
	}
	taskID, err := s.taskStore.ResolveID(args.TaskID)
	if err != nil {
		return nil, err
	}
	if err := s.taskStore.Delete(taskID); err != nil {
		return nil, err
	}
	_ = s.executor.Worktrees().Remove(taskID)
	return map[string]interface{}{"task_id": taskID, "deleted": true}, nil
}

func (s *Server) HandleTasksStopTool(argsRaw json.RawMessage) (interface{}, error) {
	args, err := parseArgs[struct {
		TaskID string `json:"task_id"`
	}](argsRaw)
	if err != nil {
		return nil, fmt.Errorf("tasks_stop: %w", err)
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
	if t.Status != "running" {
		return nil, fmt.Errorf("task %s is %q, only running tasks can be stopped", taskID, t.Status)
	}
	if err := s.executor.StopTask(taskID); err != nil {
		current, getErr := s.taskStore.Get(taskID)
		if getErr != nil {
			return nil, err
		}
		return map[string]interface{}{"task_id": taskID, "status": current.Status}, nil
	}
	if err := s.taskStore.Update(taskID, task.UpdateFields{Status: task.Ptr("stopped")}); err != nil {
		return nil, err
	}
	return map[string]interface{}{"task_id": taskID, "status": "stopped"}, nil
}

func (s *Server) HandleTasksResumeTool(argsRaw json.RawMessage) (interface{}, error) {
	args, err := parseArgs[struct {
		TaskID string `json:"task_id"`
	}](argsRaw)
	if err != nil {
		return nil, fmt.Errorf("tasks_resume: %w", err)
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
	if t.Status != "stopped" {
		return nil, fmt.Errorf("task %s is %q, only stopped tasks can be resumed", taskID, t.Status)
	}
	if strings.TrimSpace(t.SessionID) == "" {
		return nil, fmt.Errorf("task %s cannot resume without session_id", taskID)
	}
	if s.executor == nil {
		return nil, fmt.Errorf("executor not configured")
	}
	result, err := s.executor.ResumeTask(taskID)
	if err != nil {
		return nil, err
	}
	return map[string]interface{}{
		"task_id": taskID,
		"status":  result.Status,
		"result":  result,
	}, nil
}

func (s *Server) HandleTasksAddDependencyTool(argsRaw json.RawMessage) (interface{}, error) {
	args, err := parseArgs[struct {
		TaskID    string `json:"task_id"`
		DependsOn string `json:"depends_on"`
	}](argsRaw)
	if err != nil {
		return nil, fmt.Errorf("tasks_add_dependency: %w", err)
	}
	taskID, err := s.taskStore.ResolveID(args.TaskID)
	if err != nil {
		return nil, fmt.Errorf("resolve task: %w", err)
	}
	depID, err := s.taskStore.ResolveID(args.DependsOn)
	if err != nil {
		return nil, fmt.Errorf("resolve dependency: %w", err)
	}
	if err := s.taskStore.AddDependency(taskID, depID); err != nil {
		return nil, err
	}
	return map[string]interface{}{"task_id": taskID, "depends_on": depID}, nil
}

func (s *Server) HandleTasksStartTool(argsRaw json.RawMessage) (interface{}, error) {
	args, err := parseArgs[struct {
		TaskIDs []string `json:"task_ids"`
		Tool    string   `json:"tool"`
		Model   string   `json:"model"`
	}](argsRaw)
	if err != nil {
		return nil, fmt.Errorf("tasks_start: %w", err)
	}

	taskIDs := args.TaskIDs

	if len(taskIDs) == 0 {
		ready, err := s.taskStore.GetReady()
		if err != nil {
			return nil, fmt.Errorf("get ready tasks: %w", err)
		}
		if len(ready) == 0 {
			return map[string]interface{}{"error": "no ready tasks"}, nil
		}
		maxParallel := s.config.Workers.MaxParallel
		if maxParallel <= 0 {
			maxParallel = 1
		}
		if len(ready) > maxParallel {
			ready = ready[:maxParallel]
		}
		for _, t := range ready {
			taskIDs = append(taskIDs, t.ID)
		}
	}

	results, err := s.executor.RunBatch(taskIDs, executor.RunOpts{
		ToolOverride:  args.Tool,
		ModelOverride: args.Model,
	})
	if err != nil {
		return nil, err
	}
	return map[string]interface{}{
		"task_ids": taskIDs,
		"results":  results,
	}, nil
}

func (s *Server) HandleProjectStatusTool(_ json.RawMessage) (interface{}, error) {
	tasks, err := s.taskStore.List()
	if err != nil {
		return nil, err
	}

	counts := map[string]int{}
	for _, t := range tasks {
		counts[t.Status]++
	}

	return map[string]interface{}{
		"project":     s.config.Project.Name,
		"total_tasks": len(tasks),
		"by_status":   counts,
	}, nil
}
