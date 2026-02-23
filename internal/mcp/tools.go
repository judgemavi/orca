package mcp

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/jasjeetmavi/orca/internal/config"
	"github.com/jasjeetmavi/orca/internal/cost"
	"github.com/jasjeetmavi/orca/internal/decompose"
	"github.com/jasjeetmavi/orca/internal/explore"
	"github.com/jasjeetmavi/orca/internal/integrator"
	planpkg "github.com/jasjeetmavi/orca/internal/plan"
	"github.com/jasjeetmavi/orca/internal/review"
	"github.com/jasjeetmavi/orca/internal/task"
	"github.com/jasjeetmavi/orca/internal/worktree"
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
			"name":    "orca",
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
					"model": map[string]interface{}{
						"type":        "string",
						"description": "Model to use for this task (must be valid for the assigned tool)",
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
					"model": map[string]interface{}{
						"type":        "string",
						"description": "Model to use for this task",
					},
					"prompt": map[string]interface{}{
						"type":        "string",
						"description": "Custom prompt for the task",
					},
				},
				"required": []string{"task_id"},
			},
		},
		{
			Name:        "task_get",
			Description: "Get full details of a single task by ID (or prefix).",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"task_id": map[string]interface{}{"type": "string", "description": "Task ID or prefix"},
				},
				"required": []string{"task_id"},
			},
		},
		{
			Name:        "task_delete",
			Description: "Delete a task from the backlog.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"task_id": map[string]interface{}{"type": "string", "description": "Task ID or prefix"},
				},
				"required": []string{"task_id"},
			},
		},
		{
			Name:        "task_reopen",
			Description: "Move a failed task back to pending status.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"task_id": map[string]interface{}{"type": "string", "description": "Task ID or prefix"},
				},
				"required": []string{"task_id"},
			},
		},
		{
			Name:        "task_add_dependency",
			Description: "Add a dependency between two existing tasks.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"task_id":    map[string]interface{}{"type": "string", "description": "Task that depends on another"},
					"depends_on": map[string]interface{}{"type": "string", "description": "Task ID that must complete first"},
				},
				"required": []string{"task_id", "depends_on"},
			},
		},
		{
			Name:        "breakdown",
			Description: "Break down a goal into backlog tasks using an LLM. Returns proposed tasks for review.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"goal": map[string]interface{}{
						"type":        "string",
						"description": "The goal to decompose into tasks",
					},
					"tool": map[string]interface{}{
						"type":        "string",
						"description": "Tool to use for decomposition (optional, uses first available)",
					},
					"auto_create": map[string]interface{}{
						"type":        "boolean",
						"description": "If true, create tasks immediately without confirmation (default: true for MCP)",
					},
				},
				"required": []string{"goal"},
			},
		},
		{
			Name:        "task_plan_generate",
			Description: "Generate an implementation plan for a backlog task using an LLM.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"task_id": map[string]interface{}{"type": "string", "description": "Task ID"},
					"tool":    map[string]interface{}{"type": "string", "description": "Tool to use (optional)"},
					"model":   map[string]interface{}{"type": "string", "description": "Model override (optional)"},
					"save":    map[string]interface{}{"type": "boolean", "description": "Save plan to task (default: true)"},
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
			Name:        "sprint_assign",
			Description: "Add tasks to the active sprint (creates one if none exists).",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"task_ids": map[string]interface{}{
						"type":        "array",
						"items":       map[string]interface{}{"type": "string"},
						"description": "Task IDs to assign to the sprint",
					},
				},
				"required": []string{"task_ids"},
			},
		},
		{
			Name:        "sprint_unassign",
			Description: "Remove tasks from the active sprint.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"task_ids": map[string]interface{}{
						"type":        "array",
						"items":       map[string]interface{}{"type": "string"},
						"description": "Task IDs to remove from the sprint",
					},
				},
				"required": []string{"task_ids"},
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
			Name:        "project_status",
			Description: "Get project overview: task counts by status, active sprint info, and project name.",
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
			Name:        "sprint_resume",
			Description: "Detect and recover orphaned tasks from an interrupted sprint.",
			InputSchema: map[string]interface{}{
				"type":       "object",
				"properties": map[string]interface{}{},
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
		{
			Name:        "task_merge",
			Description: "Merge a single completed task into the integration branch.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"task_id": map[string]interface{}{"type": "string", "description": "Completed task ID to merge"},
				},
				"required": []string{"task_id"},
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
			Model        string   `json:"model"`
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

	case "task_update":
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

	case "task_get":
		var args struct {
			TaskID string `json:"task_id"`
		}
		if err := json.Unmarshal(argsRaw, &args); err != nil {
			return nil, fmt.Errorf("task_get args: %w", err)
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

	case "task_delete":
		var args struct {
			TaskID string `json:"task_id"`
		}
		if err := json.Unmarshal(argsRaw, &args); err != nil {
			return nil, fmt.Errorf("task_delete args: %w", err)
		}
		if strings.TrimSpace(args.TaskID) == "" {
			return nil, fmt.Errorf("task_id is required")
		}
		taskID, err := s.store.ResolveID(args.TaskID)
		if err != nil {
			return nil, err
		}
		if err := s.store.Delete(taskID); err != nil {
			return nil, err
		}
		return map[string]interface{}{"task_id": taskID, "deleted": true}, nil

	case "task_reopen":
		var args struct {
			TaskID string `json:"task_id"`
		}
		if err := json.Unmarshal(argsRaw, &args); err != nil {
			return nil, fmt.Errorf("task_reopen args: %w", err)
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

	case "task_add_dependency":
		var args struct {
			TaskID    string `json:"task_id"`
			DependsOn string `json:"depends_on"`
		}
		if err := json.Unmarshal(argsRaw, &args); err != nil {
			return nil, fmt.Errorf("task_add_dependency args: %w", err)
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

	case "breakdown":
		var args struct {
			Goal       string `json:"goal"`
			Tool       string `json:"tool"`
			AutoCreate *bool  `json:"auto_create"`
		}
		if err := json.Unmarshal(argsRaw, &args); err != nil {
			return nil, fmt.Errorf("breakdown args: %w", err)
		}
		if strings.TrimSpace(args.Goal) == "" {
			return nil, fmt.Errorf("goal is required")
		}

		var (
			toolCfg config.ToolConfig
			found   bool
		)
		if args.Tool != "" {
			tc, ok := s.cfg.Tools[args.Tool]
			if !ok {
				return nil, fmt.Errorf("tool %q not found in config", args.Tool)
			}
			toolCfg = tc
			found = true
		} else {
			for _, tc := range s.cfg.Tools {
				toolCfg = tc
				found = true
				break
			}
		}
		if !found {
			return nil, fmt.Errorf("no tools configured")
		}

		d := decompose.New(toolCfg, s.repoDir)
		tasks, err := d.Run(args.Goal)
		if err != nil {
			return nil, fmt.Errorf("decompose: %w", err)
		}

		autoCreate := true
		if args.AutoCreate != nil {
			autoCreate = *args.AutoCreate
		}
		if !autoCreate {
			proposed := make([]map[string]interface{}, len(tasks))
			for i, t := range tasks {
				proposed[i] = map[string]interface{}{
					"title":       t.Title,
					"description": t.Description,
					"tool":        t.SuggestedTool,
					"depends_on":  t.DependsOnIndices,
				}
			}
			return map[string]interface{}{"proposed_tasks": proposed, "created": false}, nil
		}

		createdIDs := make([]string, len(tasks))
		for i, t := range tasks {
			created, err := s.store.Create(t.Title, t.Description, "", t.SuggestedTool)
			if err != nil {
				return nil, fmt.Errorf("create task %d: %w", i+1, err)
			}
			createdIDs[i] = created.ID
		}
		for i, t := range tasks {
			for _, depIdx := range t.DependsOnIndices {
				if depIdx >= 0 && depIdx < len(createdIDs) {
					_ = s.store.AddDependency(createdIDs[i], createdIDs[depIdx])
				}
			}
		}
		return map[string]interface{}{
			"created":  true,
			"task_ids": createdIDs,
			"count":    len(createdIDs),
		}, nil

	case "task_plan_generate":
		var args struct {
			TaskID string `json:"task_id"`
			Tool   string `json:"tool"`
			Model  string `json:"model"`
			Save   *bool  `json:"save"`
		}
		if err := json.Unmarshal(argsRaw, &args); err != nil {
			return nil, fmt.Errorf("task_plan_generate args: %w", err)
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

		toolName := args.Tool
		if toolName == "" {
			toolName = t.AssignedTool
		}
		if toolName == "" {
			toolName = s.cfg.Defaults.Tool
		}
		if toolName == "" {
			for name := range s.cfg.Tools {
				toolName = name
				break
			}
		}
		if toolName == "" {
			return nil, fmt.Errorf("no tools configured")
		}
		toolCfg, ok := s.cfg.Tools[toolName]
		if !ok {
			return nil, fmt.Errorf("tool %q not found in config", toolName)
		}

		generator := planpkg.New(toolCfg, s.repoDir)
		var planContent string
		if args.Model != "" {
			planContent, err = generator.GenerateWithModel(t.Title, t.Description, args.Model)
		} else {
			planContent, err = generator.Generate(t.Title, t.Description)
		}
		if err != nil {
			return nil, fmt.Errorf("generate plan: %w", err)
		}

		save := true
		if args.Save != nil {
			save = *args.Save
		}
		if save {
			if err := s.store.SetPlan(taskID, planContent); err != nil {
				return nil, fmt.Errorf("save plan: %w", err)
			}
		}
		return map[string]interface{}{
			"task_id": taskID,
			"plan":    planContent,
			"saved":   save,
		}, nil

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

	case "sprint_assign":
		var args struct {
			TaskIDs []string `json:"task_ids"`
		}
		if err := json.Unmarshal(argsRaw, &args); err != nil {
			return nil, fmt.Errorf("sprint_assign args: %w", err)
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
			if err := s.planner.AddTaskToSprint(active.ID, taskID); err != nil {
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

	case "sprint_unassign":
		var args struct {
			TaskIDs []string `json:"task_ids"`
		}
		if err := json.Unmarshal(argsRaw, &args); err != nil {
			return nil, fmt.Errorf("sprint_unassign args: %w", err)
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

	case "project_status":
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

	case "sprint_resume":
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
				slog.Warn("check sprint completion after approve failed", "sprint_id", t.SprintID, "err", err)
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

		if err := s.executor.RunSingle(context.Background(), taskID); err != nil {
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

	case "task_merge":
		var args struct {
			TaskID string `json:"task_id"`
		}
		if err := json.Unmarshal(argsRaw, &args); err != nil {
			return nil, fmt.Errorf("task_merge args: %w", err)
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
		if t.Status != "completed" {
			return nil, fmt.Errorf("task %s is %q, only completed tasks can be merged", taskID, t.Status)
		}

		ig := integrator.New(s.repoDir, s.cfg.Project.IntegrationBranch, s.cfg.Validation.Commands)
		if err := ig.MergeAndValidate(taskID); err != nil {
			return nil, fmt.Errorf("merge task %s: %w", taskID, err)
		}
		if err := s.store.Update(taskID, map[string]interface{}{"status": "merged"}); err != nil {
			return nil, err
		}
		_ = s.executor.Worktrees().Remove(taskID)
		return map[string]interface{}{"task_id": taskID, "status": "merged"}, nil
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
			slog.Warn("task phase_config tool not found in config, falling back", "tool", phaseCfg.Tool, "phase", phase)
		}
	}
	if toolName == "" && t != nil && t.AssignedTool != "" {
		if tc, ok := cfg.Tools[t.AssignedTool]; ok {
			toolName = t.AssignedTool
			toolCfg = tc
		} else {
			slog.Warn("task assigned_tool not found in config, falling back to phase default", "assigned_tool", t.AssignedTool, "phase", phase)
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
	slog.Warn("task model not in tool models list, using default", "model", model, "tool", toolName)
	return ""
}
