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
		"tasks_list":  s.HandleTasksListTool,
		"task_list":   s.HandleTasksListTool,
		"tasks_start": s.HandleTasksStartTool,
		"task_start":  s.HandleTasksStartTool,
		"tasks_run": func(argsRaw json.RawMessage) (interface{}, error) {
			var params map[string]interface{}
			if err := json.Unmarshal(argsRaw, &params); err != nil {
				return nil, fmt.Errorf("tasks_run: parse args: %w", err)
			}
			return s.HandleTasksStartTool(argsRaw)
		},
		"tasks_create":               s.HandleTasksCreateTool,
		"task_create":                s.HandleTasksCreateTool,
		"tasks_update":               s.HandleTasksUpdateTool,
		"task_update":                s.HandleTasksUpdateTool,
		"tasks_get":                  s.HandleTasksGetTool,
		"task_get":                   s.HandleTasksGetTool,
		"tasks_delete":               s.HandleTasksDeleteTool,
		"task_delete":                s.HandleTasksDeleteTool,
		"tasks_stop":                 s.HandleTasksStopTool,
		"task_stop":                  s.HandleTasksStopTool,
		"tasks_cancel":               s.HandleTasksStopTool,
		"task_cancel":                s.HandleTasksStopTool,
		"tasks_resume":               s.HandleTasksResumeTool,
		"task_resume":                s.HandleTasksResumeTool,
		"tasks_add_dependency":       s.HandleTasksAddDependencyTool,
		"task_add_dependency":        s.HandleTasksAddDependencyTool,
		"breakdown":                  s.HandleBreakdownTool,
		"tasks_plan_generate":        s.HandleTasksPlanGenerateTool,
		"task_plan_generate":         s.HandleTasksPlanGenerateTool,
		"tasks_plan_evaluate":        s.HandleTasksPlanEvaluateTool,
		"task_plan_evaluate":         s.HandleTasksPlanEvaluateTool,
		"project_status":             s.HandleProjectStatusTool,
		"config_get":                 s.HandleConfigGetTool,
		"models_list":                s.HandleModelsListTool,
		"config_update":              s.HandleConfigUpdateTool,
		"tasks_approve":              s.HandleTasksApproveTool,
		"task_approve":               s.HandleTasksApproveTool,
		"tasks_approve_plan":         s.HandleTasksApprovePlanTool,
		"task_approve_plan":          s.HandleTasksApprovePlanTool,
		"tasks_request_changes":      s.HandleTasksRequestChangesTool,
		"task_request_changes":       s.HandleTasksRequestChangesTool,
		"ai_review":                  s.HandleAIReviewTool,
		"tasks_request_plan_changes": s.HandleTasksRequestPlanChangesTool,
		"task_request_plan_changes":  s.HandleTasksRequestPlanChangesTool,
		"tasks_reviews":              s.HandleTasksReviewsTool,
		"task_reviews":               s.HandleTasksReviewsTool,
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
		"task_merge":                 s.HandleTasksMergeTool,
	}
}
