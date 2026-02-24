package mcp

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/jasjeetmavi/orca/internal/decompose"
	"github.com/jasjeetmavi/orca/internal/evaluate"
	"github.com/jasjeetmavi/orca/internal/interaction"
	planpkg "github.com/jasjeetmavi/orca/internal/plan"
)

func (s *Server) HandleBreakdownTool(argsRaw json.RawMessage) (interface{}, error) {
	args, err := parseArgs[struct {
		Goal       string `json:"goal"`
		Tool       string `json:"tool"`
		AutoCreate *bool  `json:"auto_create"`
	}](argsRaw)
	if err != nil {
		return nil, fmt.Errorf("breakdown: %w", err)
	}
	if strings.TrimSpace(args.Goal) == "" {
		return nil, fmt.Errorf("goal is required")
	}

	toolName, d, err := s.config.ResolveToolForPhase("plan", args.Tool)
	if err != nil {
		return nil, err
	}
	model := s.config.ResolveModelForPhase("plan", "", d)

	interactions := interaction.NewStore(s.db, ".orca/interactions")
	decomposer := decompose.New(toolName, d, model, 10*time.Minute, s.repoDir, interactions)
	tasks, _, err := decomposer.Run(nil, args.Goal)
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
		created, err := s.taskStore.Create(t.Title, t.Description, "")
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
	return map[string]interface{}{
		"created":  true,
		"task_ids": createdIDs,
		"count":    len(createdIDs),
	}, nil
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

	toolName, d, err := s.config.ResolveToolForPhase("plan", args.Tool)
	if err != nil {
		return nil, err
	}
	model := s.config.ResolveModelForPhase("plan", args.Model, d)

	interactions := interaction.NewStore(s.db, ".orca/interactions")
	generator := planpkg.New(toolName, d, model, 10*time.Minute, s.repoDir, interactions)
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

	toolName, d, err := s.config.ResolveToolForPhase("explore", args.Tool)
	if err != nil {
		return nil, err
	}
	model := s.config.ResolveModelForPhase("explore", args.Model, d)

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
