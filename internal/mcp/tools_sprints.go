package mcp

import (
	"encoding/json"
	"fmt"
	"strings"
)

func (s *Server) HandleSprintPlanTool(argsRaw json.RawMessage) (interface{}, error) {
	args, err := parseArgs[struct {
		MaxTasks int `json:"max_tasks"`
	}](argsRaw)
	if err != nil {
		return nil, fmt.Errorf("sprint_plan: %w", err)
	}
	maxTasks := args.MaxTasks
	if maxTasks <= 0 {
		maxTasks = s.cfg.Workers.MaxParallel
	}
	if maxTasks <= 0 {
		maxTasks = 1
	}

	sp, err := s.planner.Plan(maxTasks)
	if err != nil {
		return nil, err
	}
	return map[string]interface{}{"sprint": sp}, nil
}

func (s *Server) HandleSprintAssignTool(argsRaw json.RawMessage) (interface{}, error) {
	args, err := parseArgs[struct {
		TaskIDs []string `json:"task_ids"`
	}](argsRaw)
	if err != nil {
		return nil, fmt.Errorf("sprint_assign: %w", err)
	}
	if len(args.TaskIDs) == 0 {
		return nil, fmt.Errorf("task_ids is required")
	}

	active, err := s.planner.GetActive()
	if err != nil {
		return nil, err
	}
	if active == nil {
		active, err = s.planner.CreateEmpty()
		if err != nil {
			return nil, fmt.Errorf("create sprint: %w", err)
		}
	}
	if active.Status != "planning" {
		return nil, fmt.Errorf("sprint %s is %s, cannot assign tasks", active.ID, active.Status)
	}

	var assigned []string
	var errors []string
	for _, rawID := range args.TaskIDs {
		taskID, err := s.store.ResolveID(rawID)
		if err != nil {
			errors = append(errors, fmt.Sprintf("resolve %q: %v", rawID, err))
			continue
		}
		if err := s.planner.AddTaskToSprintWithLimit(active.ID, taskID, s.cfg.Workers.MaxParallel); err != nil {
			errors = append(errors, fmt.Sprintf("assign %s: %v", taskID, err))
			continue
		}
		assigned = append(assigned, taskID)
	}
	return map[string]interface{}{
		"sprint_id": active.ID,
		"assigned":  assigned,
		"errors":    errors,
	}, nil
}

func (s *Server) HandleSprintUnassignTool(argsRaw json.RawMessage) (interface{}, error) {
	args, err := parseArgs[struct {
		TaskIDs []string `json:"task_ids"`
	}](argsRaw)
	if err != nil {
		return nil, fmt.Errorf("sprint_unassign: %w", err)
	}
	if len(args.TaskIDs) == 0 {
		return nil, fmt.Errorf("task_ids is required")
	}

	active, err := s.planner.GetActive()
	if err != nil {
		return nil, err
	}
	if active == nil {
		return nil, fmt.Errorf("no active sprint")
	}
	if active.Status != "planning" {
		return nil, fmt.Errorf("sprint %s is %s, cannot unassign tasks", active.ID, active.Status)
	}

	var removed []string
	var errors []string
	for _, rawID := range args.TaskIDs {
		taskID, err := s.store.ResolveID(rawID)
		if err != nil {
			errors = append(errors, fmt.Sprintf("resolve %q: %v", rawID, err))
			continue
		}
		if err := s.planner.RemoveTaskFromSprint(active.ID, taskID); err != nil {
			errors = append(errors, fmt.Sprintf("unassign %s: %v", taskID, err))
			continue
		}
		removed = append(removed, taskID)
	}
	return map[string]interface{}{
		"sprint_id": active.ID,
		"removed":   removed,
		"errors":    errors,
	}, nil
}

func (s *Server) HandleSprintStartTool(argsRaw json.RawMessage) (interface{}, error) {
	args, err := parseArgs[struct {
		SprintID string `json:"sprint_id"`
	}](argsRaw)
	if err != nil {
		return nil, fmt.Errorf("sprint_start: %w", err)
	}
	if strings.TrimSpace(args.SprintID) == "" {
		return nil, fmt.Errorf("sprint_id is required")
	}

	sp, err := s.planner.Get(args.SprintID)
	if err != nil {
		return nil, err
	}
	if sp.Status != "planning" {
		return nil, fmt.Errorf("sprint %s is %s, expected planning", sp.ID, sp.Status)
	}

	results, err := s.executor.Run(sp)
	if err != nil {
		return nil, err
	}
	updatedSprint, err := s.planner.Get(sp.ID)
	if err != nil {
		return nil, err
	}
	return map[string]interface{}{"sprint": updatedSprint, "results": results}, nil
}

func (s *Server) HandleSprintStatusTool(_ json.RawMessage) (interface{}, error) {
	sp, err := s.planner.GetActive()
	if err != nil {
		return nil, err
	}
	if sp == nil {
		return map[string]interface{}{"active_sprint": nil}, nil
	}

	tasks := make([]interface{}, 0, len(sp.TaskIDs))
	approved := 0
	failed := 0
	for _, taskID := range sp.TaskIDs {
		t, err := s.planner.GetTask(taskID)
		if err != nil {
			tasks = append(tasks, map[string]interface{}{"task_id": taskID, "status": "unknown"})
			continue
		}
		tasks = append(tasks, t)
		if t.Status == "approved" {
			approved++
		}
		if t.Status == "failed" {
			failed++
		}
	}
	return map[string]interface{}{
		"active_sprint": sp,
		"tasks":         tasks,
		"progress": map[string]int{
			"total":    len(sp.TaskIDs),
			"approved": approved,
			"failed":   failed,
		},
	}, nil
}

func (s *Server) HandleProjectStatusTool(_ json.RawMessage) (interface{}, error) {
	tasks, err := s.store.List()
	if err != nil {
		return nil, err
	}

	counts := map[string]int{}
	for _, t := range tasks {
		counts[t.Status]++
	}

	active, _ := s.planner.GetActive()
	var sprintInfo interface{}
	if active != nil {
		sprintInfo = map[string]interface{}{
			"id":     active.ID,
			"status": active.Status,
			"tasks":  len(active.TaskIDs),
		}
	}

	return map[string]interface{}{
		"project":       s.cfg.Project.Name,
		"total_tasks":   len(tasks),
		"by_status":     counts,
		"active_sprint": sprintInfo,
	}, nil
}

func (s *Server) HandleSprintCancelTool(argsRaw json.RawMessage) (interface{}, error) {
	args, err := parseArgs[struct {
		SprintID string `json:"sprint_id"`
	}](argsRaw)
	if err != nil {
		return nil, fmt.Errorf("sprint_cancel: %w", err)
	}
	if strings.TrimSpace(args.SprintID) == "" {
		return nil, fmt.Errorf("sprint_id is required")
	}

	if err := s.executor.Cancel(); err != nil {
		return nil, err
	}

	if sp, err := s.planner.Get(args.SprintID); err == nil {
		_ = s.executor.Cleanup(sp)
		_ = s.planner.ResetSprintTasks(args.SprintID)
		_ = s.planner.Fail(args.SprintID)
	}
	return map[string]interface{}{"status": "cancelled", "sprint_id": args.SprintID}, nil
}

func (s *Server) HandleSprintResetTool(argsRaw json.RawMessage) (interface{}, error) {
	args, err := parseArgs[struct {
		SprintID string `json:"sprint_id"`
	}](argsRaw)
	if err != nil {
		return nil, fmt.Errorf("sprint_reset: %w", err)
	}
	if strings.TrimSpace(args.SprintID) == "" {
		return nil, fmt.Errorf("sprint_id is required")
	}

	sp, err := s.planner.Get(args.SprintID)
	if err != nil {
		return nil, err
	}

	_ = s.executor.Cleanup(sp)
	if err := s.planner.ResetSprintTasks(args.SprintID); err != nil {
		return nil, err
	}
	_ = s.planner.Fail(args.SprintID)
	return map[string]interface{}{"status": "reset", "sprint_id": args.SprintID}, nil
}

func (s *Server) HandleSprintResumeTool(_ json.RawMessage) (interface{}, error) {
	orphans, err := s.planner.RecoverOrphans(s.cfg.Project.WorktreeDir, s.cfg.Project.IntegrationBranch)
	if err != nil {
		return nil, fmt.Errorf("detect orphans: %w", err)
	}
	if len(orphans) == 0 {
		return map[string]interface{}{"orphans": []string{}, "recovered": 0}, nil
	}

	recovered := make([]map[string]interface{}, 0, len(orphans))
	for _, o := range orphans {
		action := "failed"
		if o.HasCommits {
			action = "review"
		}
		if err := s.planner.ResolveOrphan(o.TaskID, o.HasCommits); err != nil {
			return nil, fmt.Errorf("resolve orphan %s: %w", o.TaskID, err)
		}
		recovered = append(recovered, map[string]interface{}{
			"task_id":     o.TaskID,
			"has_commits": o.HasCommits,
			"action":      action,
		})
	}

	active, _ := s.planner.GetActive()
	if active != nil && active.Status == "running" {
		_ = s.planner.RecoverSprint(active.ID)
	}

	return map[string]interface{}{
		"recovered": recovered,
		"count":     len(recovered),
	}, nil
}
