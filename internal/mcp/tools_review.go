package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/jasjeetmavi/orca/internal/executor"
	"github.com/jasjeetmavi/orca/internal/interaction"
	"github.com/jasjeetmavi/orca/internal/memory"
	planpkg "github.com/jasjeetmavi/orca/internal/plan"
	"github.com/jasjeetmavi/orca/internal/review"
)

func (s *Server) HandleTasksApproveTool(argsRaw json.RawMessage) (interface{}, error) {
	args, err := parseArgs[struct {
		TaskID string `json:"task_id"`
	}](argsRaw)
	if err != nil {
		return nil, fmt.Errorf("tasks_approve: %w", err)
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
	if t.Status != "review" {
		return nil, fmt.Errorf("task must be in review status to approve")
	}

	if err := s.taskStore.Update(taskID, map[string]interface{}{"status": "approved"}); err != nil {
		return nil, err
	}
	return map[string]interface{}{"task_id": taskID, "status": "approved"}, nil
}

func (s *Server) HandleTasksRequestChangesTool(argsRaw json.RawMessage) (interface{}, error) {
	args, err := parseArgs[struct {
		TaskID        string `json:"task_id"`
		Feedback      string `json:"feedback"`
		InteractionID string `json:"interaction_id"`
		Tool          string `json:"tool"`
		Model         string `json:"model"`
	}](argsRaw)
	if err != nil {
		return nil, fmt.Errorf("tasks_request_changes: %w", err)
	}
	if strings.TrimSpace(args.TaskID) == "" {
		return nil, fmt.Errorf("task_id is required")
	}
	feedback := strings.TrimSpace(args.Feedback)
	if feedback == "" {
		return nil, fmt.Errorf("feedback is required")
	}
	interactionID := strings.TrimSpace(args.InteractionID)
	tool := strings.TrimSpace(args.Tool)
	model := strings.TrimSpace(args.Model)

	taskID, err := s.taskStore.ResolveID(args.TaskID)
	if err != nil {
		return nil, err
	}
	t, err := s.taskStore.Get(taskID)
	if err != nil {
		return nil, err
	}
	if t.Status != "review" {
		return nil, fmt.Errorf("task must be in review status to request changes")
	}

	if _, err := s.taskStore.AddReview(taskID, feedback, interactionID); err != nil {
		return nil, err
	}
	if err := s.taskStore.Update(taskID, map[string]interface{}{"status": "running"}); err != nil {
		return nil, err
	}

	if err := s.executor.RunSingleWithOpts(context.Background(), taskID, executor.RunOpts{
		ToolOverride:  tool,
		ModelOverride: model,
	}); err != nil {
		return nil, err
	}
	updated, err := s.taskStore.Get(taskID)
	if err != nil {
		return nil, err
	}
	return map[string]interface{}{"task_id": taskID, "status": updated.Status}, nil
}

func (s *Server) HandleTasksApprovePlanTool(argsRaw json.RawMessage) (interface{}, error) {
	args, err := parseArgs[struct {
		TaskID string `json:"task_id"`
	}](argsRaw)
	if err != nil {
		return nil, fmt.Errorf("tasks_approve_plan: %w", err)
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
	if t.Status != "pending" {
		return nil, fmt.Errorf("task must be in pending status to approve plan")
	}
	if strings.TrimSpace(t.Plan) == "" {
		return nil, fmt.Errorf("task must have a plan to approve")
	}

	if err := s.taskStore.Update(taskID, map[string]interface{}{"status": "planned"}); err != nil {
		return nil, err
	}
	return map[string]interface{}{"task_id": taskID, "status": "planned"}, nil
}

func (s *Server) HandleTasksRequestPlanChangesTool(argsRaw json.RawMessage) (interface{}, error) {
	args, err := parseArgs[struct {
		TaskID        string `json:"task_id"`
		Feedback      string `json:"feedback"`
		InteractionID string `json:"interaction_id"`
		Tool          string `json:"tool"`
		Model         string `json:"model"`
	}](argsRaw)
	if err != nil {
		return nil, fmt.Errorf("tasks_request_plan_changes: %w", err)
	}
	if strings.TrimSpace(args.TaskID) == "" {
		return nil, fmt.Errorf("task_id is required")
	}
	feedback := strings.TrimSpace(args.Feedback)
	if feedback == "" {
		return nil, fmt.Errorf("feedback is required")
	}
	interactionID := strings.TrimSpace(args.InteractionID)
	if interactionID == "" {
		return nil, fmt.Errorf("interaction_id is required")
	}
	tool := strings.TrimSpace(args.Tool)
	model := strings.TrimSpace(args.Model)

	taskID, err := s.taskStore.ResolveID(args.TaskID)
	if err != nil {
		return nil, err
	}

	t, err := s.taskStore.Get(taskID)
	if err != nil {
		return nil, err
	}
	if t.Status != "pending" {
		return nil, fmt.Errorf("task must be in pending status to request plan changes")
	}
	if strings.TrimSpace(t.Plan) == "" {
		return nil, fmt.Errorf("task must have a plan before requesting changes")
	}

	interactions := interaction.NewStore(s.db, ".orca/interactions")
	in, err := interactions.Get(interactionID)
	if err != nil {
		return nil, fmt.Errorf("invalid interaction_id")
	}
	if in.TaskID == nil || *in.TaskID != taskID || in.Phase != "plan" || in.Status != "completed" {
		return nil, fmt.Errorf("interaction_id must reference a completed plan interaction for this task")
	}

	running, err := interactions.IsRunning(&taskID, "plan")
	if err != nil {
		return nil, err
	}
	if running {
		return nil, fmt.Errorf("plan generation already in progress")
	}

	toolName, d, err := s.config.ResolveToolForPhase("plan", tool)
	if err != nil {
		return nil, err
	}
	modelName := s.config.ResolveModelForPhase("plan", model, d)

	reviewID, err := s.taskStore.AddReview(taskID, feedback, interactionID)
	if err != nil {
		return nil, err
	}

	description := strings.TrimSpace(t.Description + "\n\nPlan feedback to incorporate:\n" + feedback)
	memStore := memory.NewStore(s.db)
	generator := planpkg.New(toolName, d, modelName, 10*time.Minute, s.repoDir, interactions).
		WithMemory(memStore).
		WithTaskStore(s.taskStore).
		WithSyncer(s.newMemorySyncer(memStore))
	planContent, err := generator.Generate(taskID, t.Title, description)
	if err != nil {
		return nil, fmt.Errorf("generate plan: %w", err)
	}
	if err := s.taskStore.SetPlan(taskID, planContent); err != nil {
		return nil, fmt.Errorf("save plan: %w", err)
	}
	if err := s.taskStore.AddressReview(reviewID); err != nil {
		return nil, fmt.Errorf("address plan review: %w", err)
	}

	updated, err := s.taskStore.Get(taskID)
	if err != nil {
		return nil, err
	}
	return map[string]interface{}{"task_id": taskID, "status": updated.Status}, nil
}

func (s *Server) HandleTasksReviewsTool(argsRaw json.RawMessage) (interface{}, error) {
	args, err := parseArgs[struct {
		TaskID string `json:"task_id"`
	}](argsRaw)
	if err != nil {
		return nil, fmt.Errorf("tasks_reviews: %w", err)
	}
	if strings.TrimSpace(args.TaskID) == "" {
		return nil, fmt.Errorf("task_id is required")
	}

	taskID, err := s.taskStore.ResolveID(args.TaskID)
	if err != nil {
		return nil, err
	}

	return s.taskStore.ListReviews(taskID)
}

func (s *Server) HandleAIReviewTool(argsRaw json.RawMessage) (interface{}, error) {
	args, err := parseArgs[struct {
		TaskID string `json:"task_id"`
		Tool   string `json:"tool"`
		Model  string `json:"model"`
		Prompt string `json:"prompt"`
	}](argsRaw)
	if err != nil {
		return nil, fmt.Errorf("ai_review: %w", err)
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
	if t.Status != "review" {
		return nil, fmt.Errorf("task must be in review status, got %q", t.Status)
	}

	toolName, d, err := s.config.ResolveToolForPhase("review", args.Tool)
	if err != nil {
		return nil, err
	}
	model := s.config.ResolveModelForPhase("review", args.Model, d)

	interactionStore := interaction.NewStore(s.db, ".orca/interactions")
	runInteractions, err := interactionStore.ListByPhase(taskID, "run")
	if err != nil {
		return nil, fmt.Errorf("list run interactions: %w", err)
	}
	var diff string
	for i := len(runInteractions) - 1; i >= 0; i-- {
		if runInteractions[i].Status == "completed" && runInteractions[i].Diff != "" {
			diff = runInteractions[i].Diff
			break
		}
	}
	if diff == "" {
		return nil, fmt.Errorf("no completed run interaction with diff found")
	}

	reviewer := review.New(toolName, d, model, 10*time.Minute, s.repoDir, interactionStore)
	userPrompt := strings.TrimSpace(args.Prompt)
	result, err := reviewer.Review(taskID, t.Title, t.Description, diff, userPrompt)
	if err != nil {
		return nil, fmt.Errorf("review failed: %w", err)
	}

	return map[string]interface{}{
		"task_id":  taskID,
		"approved": result.Approved,
		"feedback": result.Feedback,
		"tool":     result.Tool,
	}, nil
}
