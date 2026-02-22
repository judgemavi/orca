package mcp

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/jasjeetmavi/pod/internal/config"
	"github.com/jasjeetmavi/pod/internal/cost"
	"github.com/jasjeetmavi/pod/internal/explore"
	"github.com/jasjeetmavi/pod/internal/integrator"
	"github.com/jasjeetmavi/pod/internal/review"
	"github.com/jasjeetmavi/pod/internal/task"
	"github.com/jasjeetmavi/pod/internal/worktree"
)

type toolDef struct {
	Name        string      `json:"name"`
	Description string      `json:"description"`
	InputSchema interface{} `json:"inputSchema"`
}

type toolCallParams struct {
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments,omitempty"`
}

type toolContent struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type toolResult struct {
	Content           []toolContent `json:"content"`
	StructuredContent interface{}   `json:"structuredContent,omitempty"`
}

func (s *Server) handleInitialize(req jsonrpcRequest) jsonrpcResponse {
	result := map[string]interface{}{
		"protocolVersion": "2024-11-05",
		"serverInfo": map[string]string{
			"name":    "pod-mcp",
			"version": "0.1.0",
		},
		"capabilities": map[string]interface{}{
			"tools": map[string]bool{},
		},
	}
	return jsonrpcResponse{JSONRPC: "2.0", ID: req.ID, Result: result}
}

func (s *Server) handleToolsList(req jsonrpcRequest) jsonrpcResponse {
	return jsonrpcResponse{
		JSONRPC: "2.0",
		ID:      req.ID,
		Result: map[string]interface{}{
			"tools": s.toolDefinitions(),
		},
	}
}

func (s *Server) handleToolsCall(req jsonrpcRequest) jsonrpcResponse {
	var params toolCallParams
	if len(req.Params) == 0 {
		return jsonrpcResponse{JSONRPC: "2.0", ID: req.ID, Error: &rpcError{Code: -32602, Message: "invalid params: missing params"}}
	}
	if err := json.Unmarshal(req.Params, &params); err != nil {
		return jsonrpcResponse{JSONRPC: "2.0", ID: req.ID, Error: &rpcError{Code: -32602, Message: "invalid params"}}
	}
	if params.Name == "" {
		return jsonrpcResponse{JSONRPC: "2.0", ID: req.ID, Error: &rpcError{Code: -32602, Message: "invalid params: name is required"}}
	}

	result, err := s.dispatchTool(params.Name, params.Arguments)
	if err != nil {
		return jsonrpcResponse{JSONRPC: "2.0", ID: req.ID, Error: &rpcError{Code: -32000, Message: err.Error()}}
	}

	return jsonrpcResponse{JSONRPC: "2.0", ID: req.ID, Result: newToolResult(result)}
}

func (s *Server) toolDefinitions() []toolDef {
	return []toolDef{
		{
			Name:        "task_list",
			Description: "List all tasks in the backlog. Optionally filter by status.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"status": map[string]interface{}{
						"type":        "string",
						"description": "Filter by status: pending, in_sprint, running, completed, merged, failed",
					},
				},
			},
		},
		{
			Name:        "task_create",
			Description: "Create a new task in the backlog.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"title": map[string]interface{}{
						"type":        "string",
						"description": "Task title",
					},
					"description": map[string]interface{}{
						"type":        "string",
						"description": "Detailed description",
					},
					"assigned_tool": map[string]interface{}{
						"type":        "string",
						"description": "Tool to use (e.g. claude, codex)",
					},
					"depends_on": map[string]interface{}{
						"type": "array",
						"items": map[string]interface{}{
							"type": "string",
						},
						"description": "Task IDs this depends on",
					},
				},
				"required": []string{"title"},
			},
		},
		{
			Name:        "task_update",
			Description: "Update a task's title, description, status, or assigned tool.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"task_id": map[string]interface{}{"type": "string"},
					"title":   map[string]interface{}{"type": "string"},
					"description": map[string]interface{}{
						"type": "string",
					},
					"status": map[string]interface{}{"type": "string"},
					"assigned_tool": map[string]interface{}{
						"type": "string",
					},
				},
				"required": []string{"task_id"},
			},
		},
		{
			Name:        "sprint_plan",
			Description: "Create a new sprint and auto-assign ready tasks.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"max_tasks": map[string]interface{}{
						"type":        "integer",
						"description": "Max tasks to include",
					},
				},
			},
		},
		{
			Name:        "sprint_start",
			Description: "Start a planned sprint, executing all assigned tasks.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"sprint_id": map[string]interface{}{
						"type":        "string",
						"description": "Sprint ID to start",
					},
				},
				"required": []string{"sprint_id"},
			},
		},
		{
			Name:        "sprint_status",
			Description: "Get the active sprint's status, tasks, and progress.",
			InputSchema: map[string]interface{}{
				"type":       "object",
				"properties": map[string]interface{}{},
			},
		},
		{
			Name:        "sprint_cancel",
			Description: "Cancel the currently running sprint and kill all workers.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"sprint_id": map[string]interface{}{"type": "string", "description": "Sprint ID to cancel"},
				},
				"required": []string{"sprint_id"},
			},
		},
		{
			Name:        "sprint_reset",
			Description: "Reset a completed or failed sprint: cleanup worktrees and revert tasks to pending.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"sprint_id": map[string]interface{}{"type": "string", "description": "Sprint ID to reset"},
				},
				"required": []string{"sprint_id"},
			},
		},
		{
			Name:        "review_get",
			Description: "Get review artifacts (diffs, files changed, duration) for a completed sprint.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"sprint_id": map[string]interface{}{"type": "string", "description": "Sprint ID to review"},
				},
				"required": []string{"sprint_id"},
			},
		},
		{
			Name:        "review_sprint",
			Description: "Run automated LLM review on all completed tasks in a sprint. Blocks until review finishes.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"sprint_id": map[string]interface{}{"type": "string", "description": "Sprint ID to review"},
				},
				"required": []string{"sprint_id"},
			},
		},
		{
			Name:        "task_approve",
			Description: "Approve a task that is in 'review' status, moving it to 'completed'.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"task_id": map[string]interface{}{"type": "string"},
				},
				"required": []string{"task_id"},
			},
		},
		{
			Name:        "task_request_changes",
			Description: "Reject a task in review, store feedback, and re-run the worker with that feedback.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"task_id":  map[string]interface{}{"type": "string"},
					"feedback": map[string]interface{}{"type": "string", "description": "What needs to change"},
				},
				"required": []string{"task_id", "feedback"},
			},
		},
		{
			Name:        "explore",
			Description: "Run codebase exploration to build a context summary. Blocks until complete.",
			InputSchema: map[string]interface{}{
				"type":       "object",
				"properties": map[string]interface{}{},
			},
		},
		{
			Name:        "explore_status",
			Description: "Check if codebase exploration context exists and whether it is stale.",
			InputSchema: map[string]interface{}{
				"type":       "object",
				"properties": map[string]interface{}{},
			},
		},
		{
			Name:        "worktree_cleanup",
			Description: "Remove stale worktrees older than max_age_hours. Supports dry-run mode.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"dry_run": map[string]interface{}{
						"type":        "boolean",
						"description": "If true, only report stale worktrees that would be removed.",
					},
					"max_age_hours": map[string]interface{}{
						"type":        "integer",
						"description": "Max worktree age in hours before cleanup (default 168).",
					},
				},
			},
		},
		{
			Name:        "worktree_status",
			Description: "List all task worktrees with age and branch, plus total disk usage.",
			InputSchema: map[string]interface{}{
				"type":       "object",
				"properties": map[string]interface{}{},
			},
		},
		{
			Name:        "budget_status",
			Description: "Get current total cost, budget, remaining budget, and per-tool breakdown.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"sprint_id": map[string]interface{}{
						"type":        "string",
						"description": "Optional sprint ID for sprint-level totals instead of project totals.",
					},
				},
			},
		},
		{
			Name:        "quality_results",
			Description: "Get latest quality gate results for a task from stored artifacts.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"task_id": map[string]interface{}{
						"type":        "string",
						"description": "Task ID to fetch quality results for.",
					},
				},
				"required": []string{"task_id"},
			},
		},
		{
			Name:        "integrate",
			Description: "Merge all completed tasks into the integration branch.",
			InputSchema: map[string]interface{}{
				"type":       "object",
				"properties": map[string]interface{}{},
			},
		},
	}
}

func (s *Server) dispatchTool(name string, argsRaw json.RawMessage) (interface{}, error) {
	if len(argsRaw) == 0 {
		argsRaw = []byte(`{}`)
	}

	switch name {
	case "task_list":
		var args struct {
			Status string `json:"status"`
		}
		if err := json.Unmarshal(argsRaw, &args); err != nil {
			return nil, fmt.Errorf("task_list args: %w", err)
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

	case "task_create":
		var args struct {
			Title        string   `json:"title"`
			Description  string   `json:"description"`
			AssignedTool string   `json:"assigned_tool"`
			DependsOn    []string `json:"depends_on"`
		}
		if err := json.Unmarshal(argsRaw, &args); err != nil {
			return nil, fmt.Errorf("task_create args: %w", err)
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

		created, err := s.store.Get(t.ID)
		if err != nil {
			return nil, err
		}
		return map[string]interface{}{"task": created}, nil

	case "task_update":
		var args struct {
			TaskID       string  `json:"task_id"`
			Title        *string `json:"title"`
			Description  *string `json:"description"`
			Status       *string `json:"status"`
			AssignedTool *string `json:"assigned_tool"`
		}
		if err := json.Unmarshal(argsRaw, &args); err != nil {
			return nil, fmt.Errorf("task_update args: %w", err)
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

	case "sprint_plan":
		var args struct {
			MaxTasks int `json:"max_tasks"`
		}
		if err := json.Unmarshal(argsRaw, &args); err != nil {
			return nil, fmt.Errorf("sprint_plan args: %w", err)
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

	case "sprint_start":
		var args struct {
			SprintID string `json:"sprint_id"`
		}
		if err := json.Unmarshal(argsRaw, &args); err != nil {
			return nil, fmt.Errorf("sprint_start args: %w", err)
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

	case "sprint_status":
		sp, err := s.planner.GetActive()
		if err != nil {
			return nil, err
		}
		if sp == nil {
			return map[string]interface{}{"active_sprint": nil}, nil
		}

		tasks := make([]interface{}, 0, len(sp.TaskIDs))
		completed := 0
		failed := 0
		for _, taskID := range sp.TaskIDs {
			t, err := s.planner.GetTask(taskID)
			if err != nil {
				tasks = append(tasks, map[string]interface{}{"task_id": taskID, "status": "unknown"})
				continue
			}
			tasks = append(tasks, t)
			if t.Status == "completed" {
				completed++
			}
			if t.Status == "failed" {
				failed++
			}
		}
		return map[string]interface{}{
			"active_sprint": sp,
			"tasks":         tasks,
			"progress": map[string]int{
				"total":     len(sp.TaskIDs),
				"completed": completed,
				"failed":    failed,
			},
		}, nil

	case "sprint_cancel":
		var args struct {
			SprintID string `json:"sprint_id"`
		}
		if err := json.Unmarshal(argsRaw, &args); err != nil {
			return nil, fmt.Errorf("sprint_cancel args: %w", err)
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

	case "sprint_reset":
		var args struct {
			SprintID string `json:"sprint_id"`
		}
		if err := json.Unmarshal(argsRaw, &args); err != nil {
			return nil, fmt.Errorf("sprint_reset args: %w", err)
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

	case "review_get":
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

	case "review_sprint":
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
			if err != nil || t.Status != "completed" {
				continue
			}

			var diff string
			if err := s.planner.DB().QueryRow(
				`SELECT diff FROM artifacts WHERE task_id = ? AND sprint_id = ?`,
				taskID, args.SprintID,
			).Scan(&diff); err != nil || strings.TrimSpace(diff) == "" {
				continue
			}

			toolName, toolCfg, err := resolveTaskPhaseToolConfig(t, "review", s.cfg)
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

	case "task_approve":
		var args struct {
			TaskID string `json:"task_id"`
		}
		if err := json.Unmarshal(argsRaw, &args); err != nil {
			return nil, fmt.Errorf("task_approve args: %w", err)
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

		if err := s.store.Update(taskID, map[string]interface{}{"status": "completed"}); err != nil {
			return nil, err
		}
		if t.SprintID != "" {
			if err := s.planner.CompleteSprintIfDone(t.SprintID); err != nil {
				log.Printf("check sprint completion after approve %s: %v", t.SprintID, err)
			}
		}
		return map[string]interface{}{"task_id": taskID, "status": "completed"}, nil

	case "task_request_changes":
		var args struct {
			TaskID   string `json:"task_id"`
			Feedback string `json:"feedback"`
		}
		if err := json.Unmarshal(argsRaw, &args); err != nil {
			return nil, fmt.Errorf("task_request_changes args: %w", err)
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

		if err := s.executor.RunSingle(taskID); err != nil {
			return nil, err
		}
		updated, err := s.store.Get(taskID)
		if err != nil {
			return nil, err
		}
		return map[string]interface{}{"task_id": taskID, "status": updated.Status}, nil

	case "explore":
		_, toolCfg, err := s.cfg.ResolvePhaseToolConfig("explore")
		if err != nil {
			return nil, err
		}

		explorer := explore.New(toolCfg, s.repoDir)
		outPath, err := explorer.Run()
		if err != nil {
			return nil, err
		}
		return map[string]interface{}{"path": outPath}, nil

	case "explore_status":
		exists := explore.LoadContext(s.repoDir) != ""
		stale, err := explore.IsStale(s.repoDir)
		if err != nil {
			return map[string]interface{}{"error": err.Error()}, nil
		}
		ageMinutes := int(explore.ContextAge(s.repoDir) / time.Minute)
		if ageMinutes < 0 {
			ageMinutes = 0
		}
		return map[string]interface{}{
			"exists":      exists,
			"stale":       stale,
			"age_minutes": ageMinutes,
		}, nil

	case "worktree_cleanup":
		var args struct {
			DryRun      bool `json:"dry_run"`
			MaxAgeHours int  `json:"max_age_hours"`
		}
		if err := json.Unmarshal(argsRaw, &args); err != nil {
			return map[string]interface{}{"error": fmt.Sprintf("worktree_cleanup args: %v", err)}, nil
		}
		if s.cfg == nil {
			return map[string]interface{}{"error": "worktree cleanup not configured"}, nil
		}

		maxAgeHours := args.MaxAgeHours
		if maxAgeHours <= 0 {
			maxAgeHours = 168
		}
		maxAge := time.Duration(maxAgeHours) * time.Hour
		wm := worktree.NewManager(s.repoDir, s.cfg.Project.WorktreeDir)

		if args.DryRun {
			list, err := wm.ListWithAge()
			if err != nil {
				return map[string]interface{}{
					"removed": []string{},
					"errors":  []string{err.Error()},
				}, nil
			}
			removed := make([]string, 0, len(list))
			for _, wt := range list {
				if wt.Age >= maxAge {
					removed = append(removed, wt.TaskID)
				}
			}
			return map[string]interface{}{
				"removed": removed,
				"errors":  []string{},
			}, nil
		}

		removed, errs := wm.CleanupStale(maxAge)
		errTexts := make([]string, 0, len(errs))
		for _, err := range errs {
			errTexts = append(errTexts, err.Error())
		}
		return map[string]interface{}{
			"removed": removed,
			"errors":  errTexts,
		}, nil

	case "worktree_status":
		if s.cfg == nil {
			return map[string]interface{}{"error": "worktree status not configured"}, nil
		}
		wm := worktree.NewManager(s.repoDir, s.cfg.Project.WorktreeDir)

		listWithAge, err := wm.ListWithAge()
		if err != nil {
			return map[string]interface{}{"error": err.Error()}, nil
		}

		all, err := wm.List()
		if err != nil {
			return map[string]interface{}{"error": err.Error()}, nil
		}
		branchesByPath := make(map[string]string, len(all))
		for _, wt := range all {
			branchesByPath[wt.Path] = wt.Branch
		}

		totalDiskBytes, err := wm.DiskUsage()
		if err != nil {
			return map[string]interface{}{"error": err.Error()}, nil
		}

		worktrees := make([]map[string]interface{}, 0, len(listWithAge))
		for _, wt := range listWithAge {
			worktrees = append(worktrees, map[string]interface{}{
				"task_id":   wt.TaskID,
				"age_hours": int(wt.Age / time.Hour),
				"branch":    branchesByPath[wt.Path],
			})
		}
		return map[string]interface{}{
			"worktrees":        worktrees,
			"total_disk_bytes": totalDiskBytes,
		}, nil

	case "budget_status":
		var args struct {
			SprintID string `json:"sprint_id"`
		}
		if err := json.Unmarshal(argsRaw, &args); err != nil {
			return map[string]interface{}{"error": fmt.Sprintf("budget_status args: %v", err)}, nil
		}
		if s.planner == nil || s.planner.DB() == nil {
			return map[string]interface{}{"error": "cost tracking not configured"}, nil
		}

		tracker := cost.NewTracker(s.planner.DB())
		budget := s.cfg.Orchestrator.CostBudget
		if strings.TrimSpace(args.SprintID) != "" {
			total, err := tracker.SprintTotal(args.SprintID)
			if err != nil {
				return map[string]interface{}{"error": err.Error()}, nil
			}
			tools, err := tracker.SprintSummary(args.SprintID)
			if err != nil {
				return map[string]interface{}{"error": err.Error()}, nil
			}
			return map[string]interface{}{
				"sprint_id":  args.SprintID,
				"total_cost": total,
				"budget":     budget,
				"remaining":  budget - total,
				"tools":      tools,
			}, nil
		}

		total, err := tracker.ProjectTotal()
		if err != nil {
			return map[string]interface{}{"error": err.Error()}, nil
		}
		remaining, err := tracker.BudgetRemaining(budget)
		if err != nil {
			return map[string]interface{}{"error": err.Error()}, nil
		}
		tools, err := tracker.ProjectSummary()
		if err != nil {
			return map[string]interface{}{"error": err.Error()}, nil
		}
		return map[string]interface{}{
			"total_cost": total,
			"budget":     budget,
			"remaining":  remaining,
			"tools":      tools,
		}, nil

	case "quality_results":
		var args struct {
			TaskID string `json:"task_id"`
		}
		if err := json.Unmarshal(argsRaw, &args); err != nil {
			return map[string]interface{}{"error": fmt.Sprintf("quality_results args: %v", err)}, nil
		}
		taskID := strings.TrimSpace(args.TaskID)
		if taskID == "" {
			return map[string]interface{}{"error": "task_id is required"}, nil
		}
		if s.planner == nil || s.planner.DB() == nil {
			return map[string]interface{}{"error": "database not configured"}, nil
		}

		var qualityJSON sql.NullString
		err := s.planner.DB().QueryRow(
			`SELECT quality_json FROM artifacts WHERE task_id = ? ORDER BY created_at DESC LIMIT 1`,
			taskID,
		).Scan(&qualityJSON)
		if err == sql.ErrNoRows {
			return map[string]interface{}{"task_id": taskID, "quality": nil}, nil
		}
		if err != nil {
			return map[string]interface{}{"error": err.Error()}, nil
		}

		if !qualityJSON.Valid || strings.TrimSpace(qualityJSON.String) == "" {
			return map[string]interface{}{"task_id": taskID, "quality": nil}, nil
		}
		if !json.Valid([]byte(qualityJSON.String)) {
			return map[string]interface{}{"error": "invalid quality_json payload"}, nil
		}

		var quality interface{}
		if err := json.Unmarshal([]byte(qualityJSON.String), &quality); err != nil {
			return map[string]interface{}{"error": fmt.Sprintf("parse quality_json: %v", err)}, nil
		}
		return map[string]interface{}{
			"task_id": taskID,
			"quality": quality,
		}, nil

	case "integrate":
		var sprintID string
		err := s.planner.DB().QueryRow(
			`SELECT id FROM sprints WHERE status IN ('completed', 'failed') ORDER BY completed_at DESC LIMIT 1`,
		).Scan(&sprintID)
		if err == sql.ErrNoRows {
			return nil, fmt.Errorf("no completed sprint to integrate")
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
			if err == nil && t.Status == "completed" {
				taskIDs = append(taskIDs, id)
			}
		}
		if len(taskIDs) == 0 {
			return nil, fmt.Errorf("no completed tasks to integrate")
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
				// Best-effort cleanup; do not fail the MCP call.
			}
		}

		return map[string]interface{}{
			"sprint_id": sprintID,
			"merged":    merged,
			"failed":    failed,
		}, nil
	default:
		return nil, fmt.Errorf("unknown tool: %s", name)
	}
}

func newToolResult(v interface{}) toolResult {
	b, _ := json.Marshal(v)
	return toolResult{
		Content: []toolContent{{
			Type: "text",
			Text: string(b),
		}},
		StructuredContent: v,
	}
}

func resolveTaskPhaseToolConfig(t *task.Task, phase string, cfg *config.Config) (string, config.ToolConfig, error) {
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
		if tc, ok := cfg.Tools[phaseCfg.Tool]; ok {
			toolName = phaseCfg.Tool
			toolCfg = tc
		} else {
			log.Printf("task phase_config tool %q for phase %q not found in config, falling back", phaseCfg.Tool, phase)
		}
	}
	if toolName == "" && t != nil && t.AssignedTool != "" {
		if tc, ok := cfg.Tools[t.AssignedTool]; ok {
			toolName = t.AssignedTool
			toolCfg = tc
		} else {
			log.Printf("task assigned_tool %q not found in config, falling back to %s phase default", t.AssignedTool, phase)
		}
	}
	if toolName == "" {
		var err error
		toolName, toolCfg, err = cfg.ResolvePhaseToolConfig(phase)
		if err != nil {
			return "", config.ToolConfig{}, err
		}
	}

	if phaseCfg != nil {
		if model := validateTaskModel(toolName, phaseCfg.Model, toolCfg); model != "" {
			toolCfg.Model = model
			return toolName, toolCfg, nil
		}
	}
	if t != nil {
		if model := validateTaskModel(toolName, t.Model, toolCfg); model != "" {
			toolCfg.Model = model
			return toolName, toolCfg, nil
		}
	}

	if _, phaseToolCfg, err := cfg.ResolvePhaseToolConfig(phase); err == nil {
		if model := validateTaskModel(toolName, phaseToolCfg.Model, toolCfg); model != "" {
			toolCfg.Model = model
		}
	}
	return toolName, toolCfg, nil
}

func validateTaskModel(toolName, model string, toolCfg config.ToolConfig) string {
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
