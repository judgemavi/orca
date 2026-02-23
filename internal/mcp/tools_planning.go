package mcp

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/jasjeetmavi/orca/internal/config"
	"github.com/jasjeetmavi/orca/internal/decompose"
	"github.com/jasjeetmavi/orca/internal/evaluate"
	planpkg "github.com/jasjeetmavi/orca/internal/plan"
)

func (s *Server) HandleBreakdownTool(argsRaw json.RawMessage) (interface{}, error) {
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
}

func (s *Server) HandleTasksPlanGenerateTool(argsRaw json.RawMessage) (interface{}, error) {
	var args struct {
		TaskID string `json:"task_id"`
		Tool   string `json:"tool"`
		Model  string `json:"model"`
		Save   *bool  `json:"save"`
	}
	if err := json.Unmarshal(argsRaw, &args); err != nil {
		return nil, fmt.Errorf("tasks_plan_generate args: %w", err)
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
}

func (s *Server) HandleTasksPlanEvaluateTool(argsRaw json.RawMessage) (interface{}, error) {
	var args struct {
		TaskID string `json:"task_id"`
		Tool   string `json:"tool"`
		Model  string `json:"model"`
	}
	if err := json.Unmarshal(argsRaw, &args); err != nil {
		return nil, fmt.Errorf("tasks_plan_evaluate args: %w", err)
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

	evaluator := evaluate.New(toolCfg, s.repoDir)
	var evaluationResult *evaluate.EvaluationResult
	if args.Model != "" {
		evaluationResult, err = evaluator.EvaluateWithModel(t.Title, t.Description, args.Model)
	} else {
		evaluationResult, err = evaluator.Evaluate(t.Title, t.Description)
	}
	if err != nil {
		return nil, fmt.Errorf("evaluate plan: %w", err)
	}

	return map[string]interface{}{
		"task_id":    taskID,
		"evaluation": evaluationResult,
	}, nil
}
