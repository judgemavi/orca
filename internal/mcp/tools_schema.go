package mcp

import "encoding/json"

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
			Name:        "tasks_list",
			Description: "List all tasks. Optionally filter by status.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"status": map[string]interface{}{
						"type":        "string",
						"description": "Filter by status: pending, planned, running, review, approved, merged, failed",
					},
				},
			},
		},
		{
			Name:        "tasks_start",
			Description: "Start execution of ready tasks",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"task_ids": map[string]interface{}{
						"type":        "array",
						"items":       map[string]interface{}{"type": "string"},
						"description": "Task IDs to run. If empty, runs all ready tasks up to max_parallel.",
					},
					"tool": map[string]interface{}{
						"type":        "string",
						"description": "Tool override for this run.",
					},
					"model": map[string]interface{}{
						"type":        "string",
						"description": "Model override for this run.",
					},
				},
			},
		},
		{
			Name:        "tasks_create",
			Description: "Create a new task.",
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
			Name:        "tasks_update",
			Description: "Update a task's title, description, status, or plan.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"task_id": map[string]interface{}{"type": "string"},
					"title":   map[string]interface{}{"type": "string"},
					"description": map[string]interface{}{
						"type": "string",
					},
					"status": map[string]interface{}{"type": "string"},
					"plan":   map[string]interface{}{"type": "string"},
				},
				"required": []string{"task_id"},
			},
		},
		{
			Name:        "tasks_get",
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
			Name:        "tasks_delete",
			Description: "Delete a task.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"task_id": map[string]interface{}{"type": "string", "description": "Task ID or prefix"},
				},
				"required": []string{"task_id"},
			},
		},
		{
			Name:        "tasks_stop",
			Description: "Stop a running task. Task can be resumed later.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"task_id": map[string]interface{}{"type": "string", "description": "Task ID or prefix"},
				},
				"required": []string{"task_id"},
			},
		},
		{
			Name:        "tasks_resume",
			Description: "Resume a stopped task from where it left off using its saved session",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"task_id": map[string]interface{}{"type": "string", "description": "Task ID or prefix"},
				},
				"required": []string{"task_id"},
			},
		},
		{
			Name:        "tasks_add_dependency",
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
			Description: "Break down a goal into tasks using an LLM, or break down an existing task into child subtasks. Returns proposed tasks for review.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"goal": map[string]interface{}{
						"type":        "string",
						"description": "The goal to breakdown into tasks",
					},
					"task_id": map[string]interface{}{
						"type":        "string",
						"description": "Optional task ID to breakdown. Uses task title+description as goal. Created subtasks will be children of this task.",
					},
					"tool": map[string]interface{}{
						"type":        "string",
						"description": "Tool to use for breakdown (optional, uses first available)",
					},
					"auto_create": map[string]interface{}{
						"type":        "boolean",
						"description": "If true, create tasks immediately without confirmation (default: true for MCP)",
					},
				},
			},
		},
		{
			Name:        "tasks_plan_generate",
			Description: "Generate an implementation plan for a task using an LLM.",
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
			Name:        "tasks_plan_evaluate",
			Description: "Evaluate whether a task should be broken down into subtasks before planning. Returns complexity assessment.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"task_id": map[string]interface{}{"type": "string", "description": "Task ID"},
					"tool":    map[string]interface{}{"type": "string", "description": "Tool to use for evaluation"},
					"model":   map[string]interface{}{"type": "string", "description": "Model override"},
				},
				"required": []string{"task_id"},
			},
		},
		{
			Name:        "tasks_retro",
			Description: "Extract reusable memory from an approved or merged task.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"task_id": map[string]interface{}{
						"type":        "string",
						"description": "Task ID",
					},
					"tool": map[string]interface{}{
						"type":        "string",
						"description": "Tool override (optional)",
					},
					"model": map[string]interface{}{
						"type":        "string",
						"description": "Model override (optional)",
					},
				},
				"required": []string{"task_id"},
			},
		},
		{
			Name:        "project_status",
			Description: "Get project overview: task counts by status and project name.",
			InputSchema: map[string]interface{}{
				"type":       "object",
				"properties": map[string]interface{}{},
			},
		},
		{
			Name:        "config_get",
			Description: "Get the current runtime configuration.",
			InputSchema: map[string]interface{}{
				"type":       "object",
				"properties": map[string]interface{}{},
			},
		},
		{
			Name:        "models_list",
			Description: "List available LLM models for configured tools. Optionally filter by a specific tool name.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"tool": map[string]interface{}{
						"type":        "string",
						"description": "Filter models by tool name (optional)",
					},
				},
			},
		},
		{
			Name:        "config_update",
			Description: "Apply a partial JSON patch to configuration and persist it.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"patch": map[string]interface{}{
						"type":        "object",
						"description": "Partial configuration object to merge and persist.",
					},
				},
				"required": []string{"patch"},
			},
		},
		{
			Name:        "tasks_approve",
			Description: "Approve a task that is in 'review' status, moving it to 'approved'.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"task_id": map[string]interface{}{"type": "string"},
				},
				"required": []string{"task_id"},
			},
		},
		{
			Name:        "tasks_approve_plan",
			Description: "Approve a generated plan for a pending task, moving it to 'planned'.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"task_id": map[string]interface{}{"type": "string"},
				},
				"required": []string{"task_id"},
			},
		},
		{
			Name:        "tasks_request_changes",
			Description: "Reject a task in review, store feedback, and re-run the worker with that feedback.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"task_id": map[string]interface{}{"type": "string"},
					"feedback": map[string]interface{}{
						"type":        "string",
						"description": "What needs to change",
					},
					"interaction_id": map[string]interface{}{
						"type":        "string",
						"description": "Optional interaction ID linked to this review request.",
					},
					"tool": map[string]interface{}{
						"type":        "string",
						"description": "Tool override for rerun.",
					},
					"model": map[string]interface{}{
						"type":        "string",
						"description": "Model override for rerun.",
					},
				},
				"required": []string{"task_id", "feedback"},
			},
		},
		{
			Name:        "ai_review",
			Description: "Run automated AI code review on a task's diff. Task must be in 'review' status. Returns approval status and feedback. Does NOT change task status - the orchestrator decides next action.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"task_id": map[string]interface{}{
						"type":        "string",
						"description": "Task ID (or prefix) to review",
					},
					"tool": map[string]interface{}{
						"type":        "string",
						"description": "Tool override (optional, defaults to review phase config)",
					},
					"model": map[string]interface{}{
						"type":        "string",
						"description": "Model override (optional)",
					},
					"prompt": map[string]interface{}{
						"type":        "string",
						"description": "Optional custom instructions for the reviewer",
					},
				},
				"required": []string{"task_id"},
			},
		},
		{
			Name:        "tasks_request_plan_changes",
			Description: "Request changes to a pending task's plan, recording feedback and regenerating the plan.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"task_id":        map[string]interface{}{"type": "string"},
					"feedback":       map[string]interface{}{"type": "string", "description": "What needs to change in the plan"},
					"interaction_id": map[string]interface{}{"type": "string", "description": "Completed plan interaction ID being reviewed"},
					"tool":           map[string]interface{}{"type": "string", "description": "Tool override for plan regeneration (optional)"},
					"model":          map[string]interface{}{"type": "string", "description": "Model override for plan regeneration (optional)"},
				},
				"required": []string{"task_id", "feedback", "interaction_id"},
			},
		},
		{
			Name:        "tasks_reviews",
			Description: "List reviews for a task, including feedback, status (pending/addressed), and linked interaction ID.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"task_id": map[string]interface{}{"type": "string", "description": "Task ID or prefix"},
				},
				"required": []string{"task_id"},
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
			Name:        "cost_status",
			Description: "Get current cost status: total cost and per-tool breakdown.",
			InputSchema: map[string]interface{}{
				"type":       "object",
				"properties": map[string]interface{}{},
			},
		},
		{
			Name:        "quality_results",
			Description: "Get latest quality gate results for a task from run-phase task interactions.",
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
			Name:        "interactions_list",
			Description: "List LLM interaction logs for a task, with optional filtering by phase and status.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"task_id": map[string]interface{}{
						"type":        "string",
						"description": "Task ID to list interactions for.",
					},
					"phase": map[string]interface{}{
						"type":        "string",
						"description": "Optional phase filter: plan, run, review, merge.",
					},
					"status": map[string]interface{}{
						"type":        "string",
						"description": "Optional status filter: running, completed, failed.",
					},
				},
				"required": []string{"task_id"},
			},
		},
		{
			Name:        "interaction_get",
			Description: "Get the formatted log content of a specific interaction. Use interactions_list to find IDs first.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"interaction_id": map[string]interface{}{
						"type":        "string",
						"description": "Interaction ID from interactions_list.",
					},
					"raw": map[string]interface{}{
						"type":        "boolean",
						"description": "Return raw NDJSON content instead of formatted text. Default: false.",
					},
				},
				"required": []string{"interaction_id"},
			},
		},
		{
			Name:        "log_event",
			Description: "Write a structured log entry to the application log.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"level": map[string]interface{}{
						"type":        "string",
						"description": "Log level: debug, info, warn, error",
					},
					"message": map[string]interface{}{
						"type":        "string",
						"description": "Log message",
					},
					"task_id": map[string]interface{}{
						"type":        "string",
						"description": "Optional task ID to attach as structured attribute.",
					},
					"attrs": map[string]interface{}{
						"type":                 "object",
						"additionalProperties": true,
						"description":          "Optional additional structured attributes.",
					},
				},
				"required": []string{"level", "message"},
			},
		},
		{
			Name:        "log_query",
			Description: "Query structured application logs with optional filters.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"level": map[string]interface{}{
						"type":        "string",
						"description": "Optional level filter: debug, info, warn, error",
					},
					"task_id": map[string]interface{}{
						"type":        "string",
						"description": "Optional task ID filter.",
					},
					"since": map[string]interface{}{
						"type":        "string",
						"description": "Optional time filter: RFC3339 timestamp or duration (e.g. 30m, 2h).",
					},
					"limit": map[string]interface{}{
						"type":        "integer",
						"description": "Optional max number of matching entries.",
					},
					"pattern": map[string]interface{}{
						"type":        "string",
						"description": "Optional case-insensitive substring match against message/raw line.",
					},
				},
			},
		},
		{
			Name:        "merge",
			Description: "Merge all approved tasks into the integration branch.",
			InputSchema: map[string]interface{}{
				"type":       "object",
				"properties": map[string]interface{}{},
			},
		},
		{
			Name:        "tasks_merge",
			Description: "Merge a single approved task into the integration branch.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"task_id": map[string]interface{}{"type": "string", "description": "Completed task ID to merge"},
				},
				"required": []string{"task_id"},
			},
		},
		{
			Name:        "memory_list",
			Description: "List memory entries. Optionally filter by category, tag, source type, or file path.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"category": map[string]interface{}{
						"type":        "string",
						"description": "Optional category filter: pattern, pitfall, preference, convention, architecture, dependency.",
					},
					"tag": map[string]interface{}{
						"type":        "string",
						"description": "Optional exact tag filter.",
					},
					"source_type": map[string]interface{}{
						"type":        "string",
						"description": "Optional source type filter: retro, task, commit.",
					},
					"file_path": map[string]interface{}{
						"type":        "string",
						"description": "Optional file path filter for associated files.",
					},
				},
			},
		},
		{
			Name:        "memory_get",
			Description: "Get a single memory entry by id.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"id": map[string]interface{}{
						"type":        "string",
						"description": "Memory entry ID.",
					},
				},
				"required": []string{"id"},
			},
		},
		{
			Name:        "memory_search",
			Description: "Search memory entries using FTS, optionally filtered by source type or file path.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"query": map[string]interface{}{
						"type":        "string",
						"description": "Full-text query string.",
					},
					"limit": map[string]interface{}{
						"type":        "integer",
						"description": "Maximum number of results (default: 10).",
					},
					"source_type": map[string]interface{}{
						"type":        "string",
						"description": "Optional source type filter: retro, task, commit.",
					},
					"file_path": map[string]interface{}{
						"type":        "string",
						"description": "Optional file path filter for associated files.",
					},
				},
				"required": []string{"query"},
			},
		},
		{
			Name:        "memory_update",
			Description: "Update an existing memory entry.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"id": map[string]interface{}{
						"type":        "string",
						"description": "Memory entry ID.",
					},
					"content": map[string]interface{}{
						"type":        "string",
						"description": "Updated memory content.",
					},
					"confidence": map[string]interface{}{
						"type":        "number",
						"description": "Updated confidence score between 0 and 1.",
					},
					"category": map[string]interface{}{
						"type":        "string",
						"description": "Updated category: pattern, pitfall, preference, convention, architecture, dependency.",
					},
				},
				"required": []string{"id"},
			},
		},
		{
			Name:        "memory_delete",
			Description: "Delete a memory entry by id.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"id": map[string]interface{}{
						"type":        "string",
						"description": "Memory entry ID.",
					},
				},
				"required": []string{"id"},
			},
		},
		{
			Name:        "memory_sync",
			Description: "Sync memory entries with git changes, flagging stale entries.",
			InputSchema: map[string]interface{}{
				"type":       "object",
				"properties": map[string]interface{}{},
			},
		},
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
