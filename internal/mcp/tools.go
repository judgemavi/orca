package mcp

import (
	"encoding/json"
	"fmt"
)

type toolHandler func(argsRaw json.RawMessage) (interface{}, error)

func (s *Server) dispatchTool(name string, argsRaw json.RawMessage) (interface{}, error) {
	if len(argsRaw) == 0 {
		argsRaw = []byte(`{}`)
	}

	handlers := s.toolHandlers()
	handler, ok := handlers[name]
	if !ok {
		return nil, fmt.Errorf("unknown tool: %s", name)
	}
	return handler(argsRaw)
}

func (s *Server) toolHandlers() map[string]toolHandler {
	return map[string]toolHandler{
		"tasks_list":                 s.HandleTasksListTool,
		"tasks_start":                s.HandleTasksStartTool,
		"tasks_create":               s.HandleTasksCreateTool,
		"tasks_update":               s.HandleTasksUpdateTool,
		"tasks_get":                  s.HandleTasksGetTool,
		"tasks_delete":               s.HandleTasksDeleteTool,
		"tasks_stop":                 s.HandleTasksStopTool,
		"tasks_resume":               s.HandleTasksResumeTool,
		"tasks_add_dependency":       s.HandleTasksAddDependencyTool,
		"breakdown":                  s.HandleBreakdownTool,
		"tasks_plan_generate":        s.HandleTasksPlanGenerateTool,
		"tasks_plan_evaluate":        s.HandleTasksPlanEvaluateTool,
		"tasks_retro":                s.HandleTasksRetroTool,
		"project_status":             s.HandleProjectStatusTool,
		"config_get":                 s.HandleConfigGetTool,
		"models_list":                s.HandleModelsListTool,
		"config_update":              s.HandleConfigUpdateTool,
		"tasks_approve":              s.HandleTasksApproveTool,
		"tasks_approve_plan":         s.HandleTasksApprovePlanTool,
		"tasks_request_changes":      s.HandleTasksRequestChangesTool,
		"ai_review":                  s.HandleAIReviewTool,
		"tasks_request_plan_changes": s.HandleTasksRequestPlanChangesTool,
		"tasks_reviews":              s.HandleTasksReviewsTool,
		"explore":                    s.HandleExploreTool,
		"explore_status":             s.HandleExploreStatusTool,
		"worktree_cleanup":           s.HandleWorktreeCleanupTool,
		"worktree_status":            s.HandleWorktreeStatusTool,
		"cost_status":                s.HandleCostStatusTool,
		"quality_results":            s.HandleQualityResultsTool,
		"interactions_list":          s.HandleInteractionsListTool,
		"interaction_get":            s.HandleInteractionGetTool,
		"log_event":                  s.HandleLogEventTool,
		"log_query":                  s.HandleLogQueryTool,
		"merge":                      s.HandleMergeTool,
		"tasks_merge":                s.HandleTasksMergeTool,
		"memory_list":                s.HandleMemoryListTool,
		"memory_get":                 s.HandleMemoryGetTool,
		"memory_search":              s.HandleMemorySearchTool,
		"memory_update":              s.HandleMemoryUpdateTool,
		"memory_delete":              s.HandleMemoryDeleteTool,
		"memory_sync":                s.HandleMemorySyncTool,
		"memory_status":              s.HandleMemoryStatusTool,
	}
}
