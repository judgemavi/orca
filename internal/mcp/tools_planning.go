package mcp

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/jasjeetmavi/orca/internal/breakdown"
	"github.com/jasjeetmavi/orca/internal/evaluate"
	"github.com/jasjeetmavi/orca/internal/interaction"
	"github.com/jasjeetmavi/orca/internal/memory"
	planpkg "github.com/jasjeetmavi/orca/internal/plan"
)

func (s *Server) HandleBreakdownTool(argsRaw json.RawMessage) (interface{}, error) {
	args, err := parseArgs[struct {
		Goal       string `json:"goal"`
		TaskID     string `json:"task_id"`
		Tool       string `json:"tool"`
		AutoCreate *bool  `json:"auto_create"`
	}](argsRaw)
	if err != nil {
		return nil, fmt.Errorf("breakdown: %w", err)
	}
	hasGoal := strings.TrimSpace(args.Goal) != ""
	hasTaskID := strings.TrimSpace(args.TaskID) != ""
	if hasGoal && hasTaskID {
		return nil, fmt.Errorf("provide either goal or task_id, not both")
	}
	if !hasGoal && !hasTaskID {
		return nil, fmt.Errorf("either goal or task_id is required")
	}

	goal := args.Goal
	var parentTaskID *string
	if hasTaskID {
		taskID, err := s.taskStore.ResolveID(args.TaskID)
		if err != nil {
			return nil, err
		}
		parentTask, err := s.taskStore.Get(taskID)
		if err != nil {
			return nil, err
		}
		goal = parentTask.Title + "\n\n" + parentTask.Description
		parentTaskID = &taskID
	}

	toolName, d, err := s.config.ResolveToolForPhase(interaction.PhasePlan, args.Tool)
	if err != nil {
		return nil, err
	}
	model := s.config.ResolveModelForPhase(interaction.PhasePlan, "", d)

	interactions := interaction.NewStore(s.db, ".orca/interactions")
	breaker := breakdown.New(toolName, d, model, 10*time.Minute, s.repoDir, interactions)
	tasks, _, err := breaker.Run(parentTaskID, goal)
	if err != nil {
		return nil, fmt.Errorf("breakdown: %w", err)
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
	parentID := ""
	if parentTaskID != nil {
		parentID = *parentTaskID
	}
	for i, t := range tasks {
		created, err := s.taskStore.Create(t.Title, t.Description, parentID)
		if err != nil {
			return nil, fmt.Errorf("create task %d: %w", i+1, err)
		}
		createdIDs[i] = created.ID
	}
	for i, t := range tasks {
		for _, depIdx := range t.DependsOnIndices {
			if depIdx >= 0 && depIdx < len(createdIDs) {
				if err := s.taskStore.AddDependency(createdIDs[i], createdIDs[depIdx]); err != nil {
					return nil, fmt.Errorf("add dependency %q -> %q: %w", createdIDs[i], createdIDs[depIdx], err)
				}
			}
		}
	}
	resp := map[string]interface{}{
		"created":  true,
		"task_ids": createdIDs,
		"count":    len(createdIDs),
	}
	if parentTaskID != nil {
		if err := s.taskStore.Update(*parentTaskID, map[string]interface{}{"status": "broken_down"}); err != nil {
			return nil, fmt.Errorf("update parent task status: %w", err)
		}
		resp["parent_id"] = *parentTaskID
	}
	return resp, nil
}

func (s *Server) HandleTasksPlanGenerateTool(argsRaw json.RawMessage) (interface{}, error) {
	args, err := parseArgs[struct {
		TaskID string `json:"task_id"`
		Tool   string `json:"tool"`
		Model  string `json:"model"`
		Save   *bool  `json:"save"`
	}](argsRaw)
	if err != nil {
		return nil, fmt.Errorf("tasks_plan_generate: %w", err)
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

	toolName, d, err := s.config.ResolveToolForPhase(interaction.PhasePlan, args.Tool)
	if err != nil {
		return nil, err
	}
	model := s.config.ResolveModelForPhase(interaction.PhasePlan, args.Model, d)

	interactions := interaction.NewStore(s.db, ".orca/interactions")
	generator := planpkg.New(toolName, d, model, 10*time.Minute, s.repoDir, interactions).
		WithMemory(memory.NewStore(s.db))
	var planContent string
	planContent, err = generator.Generate(taskID, t.Title, t.Description)
	if err != nil {
		return nil, fmt.Errorf("generate plan: %w", err)
	}

	save := true
	if args.Save != nil {
		save = *args.Save
	}
	if save {
		if err := s.taskStore.SetPlan(taskID, planContent); err != nil {
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
	args, err := parseArgs[struct {
		TaskID string `json:"task_id"`
		Tool   string `json:"tool"`
		Model  string `json:"model"`
	}](argsRaw)
	if err != nil {
		return nil, fmt.Errorf("tasks_plan_evaluate: %w", err)
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

	toolName, d, err := s.config.ResolveToolForPhase(interaction.PhaseExplore, args.Tool)
	if err != nil {
		return nil, err
	}
	model := s.config.ResolveModelForPhase(interaction.PhaseExplore, args.Model, d)

	evaluator := evaluate.New(toolName, d, model, 10*time.Minute, s.repoDir, interaction.NewStore(s.db, ".orca/interactions"))
	var evaluationResult *evaluate.EvaluationResult
	evaluationResult, err = evaluator.Evaluate(taskID, t.Title, t.Description)
	if err != nil {
		return nil, fmt.Errorf("evaluate plan: %w", err)
	}

	return map[string]interface{}{
		"task_id":    taskID,
		"evaluation": evaluationResult,
	}, nil
}
