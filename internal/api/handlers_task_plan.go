package api

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/jasjeetmavi/orca/internal/breakdown"
	"github.com/jasjeetmavi/orca/internal/evaluate"
	"github.com/jasjeetmavi/orca/internal/interaction"
	"github.com/jasjeetmavi/orca/internal/memory"
	"github.com/jasjeetmavi/orca/internal/plan"
	"github.com/jasjeetmavi/orca/internal/task"
)

// ========== Task Plans ==========

func (s *Server) handleGetTaskPlan(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !requireMethod(w, r, http.MethodGet) {
		return
	}

	store := s.taskStore
	resolved, ok := resolveTaskID(w, store, id)
	if !ok {
		return
	}
	var err error

	content, err := store.GetPlan(resolved)
	if err != nil {
		jsonError(w, err, http.StatusInternalServerError)
		return
	}

	jsonOK(w, map[string]string{"plan": content})
}

func (s *Server) handlePutTaskPlan(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !requireMethod(w, r, http.MethodPut) {
		return
	}

	type planReq struct {
		Plan string `json:"plan"`
	}
	req, ok := decodeJSON[planReq](w, r, false)
	if !ok {
		return
	}

	store := s.taskStore
	resolved, ok := resolveTaskID(w, store, id)
	if !ok {
		return
	}
	tk, err := store.Get(resolved)
	if err != nil {
		jsonError(w, err, http.StatusNotFound)
		return
	}
	if tk.Status != "pending" && tk.Status != "planned" {
		jsonError(w, "task plan can only be edited while task is pending or planned", http.StatusBadRequest)
		return
	}

	if err := store.SetPlan(resolved, req.Plan); err != nil {
		jsonError(w, err, http.StatusInternalServerError)
		return
	}

	jsonOK(w, map[string]string{"plan": req.Plan})
}

func (s *Server) handleGenerateTaskPlan(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !requireMethod(w, r, http.MethodPost) {
		return
	}

	type genReq struct {
		Tool  string `json:"tool"`
		Model string `json:"model"`
	}
	req, ok := decodeJSON[genReq](w, r, true)
	if !ok {
		return
	}

	store := s.taskStore
	resolved, ok := resolveTaskID(w, store, id)
	if !ok {
		return
	}
	if status, err := s.generateTaskPlan(resolved, req.Tool, req.Model, "", ""); err != nil {
		jsonError(w, err, status)
		return
	}
	jsonResponse(w, http.StatusAccepted, map[string]interface{}{"data": map[string]string{"status": "generating"}})
}

// POST /api/v1/tasks/{id}/request-plan-changes
func (s *Server) handleRequestPlanChanges(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !requireMethod(w, r, http.MethodPost) {
		return
	}

	type requestReq struct {
		Feedback      string `json:"feedback"`
		InteractionID string `json:"interaction_id"`
		Tool          string `json:"tool"`
		Model         string `json:"model"`
	}
	req, ok := decodeJSON[requestReq](w, r, false)
	if !ok {
		return
	}

	feedback := strings.TrimSpace(req.Feedback)
	interactionID := strings.TrimSpace(req.InteractionID)
	if feedback == "" {
		jsonError(w, "feedback required", http.StatusBadRequest)
		return
	}
	if interactionID == "" {
		jsonError(w, "interaction_id required", http.StatusBadRequest)
		return
	}

	store := s.taskStore
	resolved, ok := resolveTaskID(w, store, id)
	if !ok {
		return
	}

	tk, err := store.Get(resolved)
	if err != nil {
		jsonError(w, err, http.StatusNotFound)
		return
	}
	if tk.Status != "pending" {
		jsonError(w, "task must be in pending status to request plan changes", http.StatusBadRequest)
		return
	}
	if strings.TrimSpace(tk.Plan) == "" {
		jsonError(w, "task must have a plan before requesting changes", http.StatusBadRequest)
		return
	}
	if s.interactions != nil {
		in, getErr := s.interactions.Get(interactionID)
		if getErr != nil {
			jsonError(w, "invalid interaction_id", http.StatusBadRequest)
			return
		}
		if in.TaskID == nil || *in.TaskID != resolved || in.Phase != interaction.PhasePlan || in.Status != "completed" {
			jsonError(w, "interaction_id must reference a completed plan interaction for this task", http.StatusBadRequest)
			return
		}
	}

	if status, err := s.generateTaskPlan(resolved, req.Tool, req.Model, feedback, interactionID); err != nil {
		jsonError(w, err, status)
		return
	}
	jsonResponse(w, http.StatusAccepted, map[string]interface{}{"data": map[string]string{"status": "generating"}})
}

func (s *Server) generateTaskPlan(taskID, tool, model, feedback, reviewInteractionID string) (int, error) {
	if running, err := s.interactions.IsRunning(&taskID, interaction.PhasePlan); err != nil {
		return http.StatusInternalServerError, err
	} else if running {
		return http.StatusConflict, fmt.Errorf("plan generation already in progress")
	}

	tk, err := s.taskStore.Get(taskID)
	if err != nil {
		return http.StatusNotFound, err
	}
	if tk.Status != "pending" {
		return http.StatusBadRequest, fmt.Errorf("task must be in pending status to generate plan")
	}

	tool = strings.TrimSpace(tool)
	model = strings.TrimSpace(model)
	feedback = strings.TrimSpace(feedback)

	toolName, toolDef, err := s.cfg.ResolveToolForPhase(interaction.PhasePlan, tool)
	if err != nil {
		if tool != "" {
			return http.StatusBadRequest, err
		}
		return http.StatusInternalServerError, err
	}
	modelOverride := s.cfg.ResolveModelForPhase(interaction.PhasePlan, model, toolName)

	description := tk.Description
	if feedback != "" {
		description = strings.TrimSpace(description + "\n\nPlan feedback to incorporate:\n" + feedback)
	}
	reviewID := ""
	if reviewInteractionID != "" {
		var addErr error
		reviewID, addErr = s.taskStore.AddReview(taskID, feedback, reviewInteractionID)
		if addErr != nil {
			return http.StatusInternalServerError, addErr
		}
	}

	s.hub.Broadcast(Event{
		Type: "plan.generating",
		Data: map[string]string{"task_id": taskID},
	})

	go func(taskID, title, description, reviewID string) {
		memoryStore := memory.NewStore(s.db)
		generator := plan.New(toolName, toolDef, modelOverride, 10*time.Minute, s.repoDir, s.interactions).
			WithMemory(memoryStore).
			WithTaskStore(s.taskStore).
			WithSyncer(s.newMemorySyncer(memoryStore))
		content, genErr := generator.Generate(taskID, title, description)
		if genErr != nil {
			s.hub.Broadcast(Event{
				Type: "plan.failed",
				Data: map[string]string{
					"task_id": taskID,
					"error":   genErr.Error(),
				},
			})
			return
		}

		if err := s.taskStore.SetPlan(taskID, content); err != nil {
			s.hub.Broadcast(Event{
				Type: "plan.failed",
				Data: map[string]string{
					"task_id": taskID,
					"error":   err.Error(),
				},
			})
			return
		}
		if reviewID != "" {
			if err := s.taskStore.AddressReview(reviewID); err != nil {
				slog.Warn("address plan review failed", "task_id", taskID, "review_id", reviewID, "err", err)
			}
		}

		s.hub.Broadcast(Event{
			Type: "plan.completed",
			Data: map[string]string{
				"task_id": taskID,
				"plan":    content,
			},
		})
	}(taskID, tk.Title, description, reviewID)

	return 0, nil
}

// POST /api/v1/tasks/{id}/evaluate
func (s *Server) handleEvaluateTask(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !requireMethod(w, r, http.MethodPost) {
		return
	}

	type evalReq struct {
		Tool  string `json:"tool"`
		Model string `json:"model"`
	}
	req, ok := decodeJSON[evalReq](w, r, true)
	if !ok {
		return
	}

	store := s.taskStore
	resolved, ok := resolveTaskID(w, store, id)
	if !ok {
		return
	}
	var err error

	tk, err := store.Get(resolved)
	if err != nil {
		jsonError(w, err, http.StatusNotFound)
		return
	}

	if running, runErr := s.interactions.IsRunning(&resolved, interaction.PhaseEvaluate); runErr != nil {
		jsonError(w, runErr, http.StatusInternalServerError)
		return
	} else if running {
		jsonError(w, "evaluation already in progress", http.StatusConflict)
		return
	}

	toolName, toolDef, err := s.cfg.ResolveToolForPhase(interaction.PhaseExplore, req.Tool)
	if err != nil {
		if strings.TrimSpace(req.Tool) != "" {
			jsonError(w, err, http.StatusBadRequest)
		} else {
			jsonError(w, err, http.StatusInternalServerError)
		}
		return
	}

	modelOverride := s.cfg.ResolveModelForPhase(interaction.PhaseExplore, strings.TrimSpace(req.Model), toolName)
	jsonResponse(w, http.StatusAccepted, map[string]interface{}{
		"data": map[string]string{
			"task_id": resolved,
			"status":  "started",
		},
	})

	s.hub.Broadcast(Event{
		Type: "evaluate.started",
		Data: map[string]string{
			"task_id": resolved,
		},
	})

	go func(taskID, title, description string) {
		memStore := memory.NewStore(s.db)
		evaluator := evaluate.New(toolName, toolDef, modelOverride, 10*time.Minute, s.repoDir, s.interactions).
			WithMemory(memStore).
			WithTaskStore(s.taskStore).
			WithSyncer(s.newMemorySyncer(memStore))
		result, evalErr := evaluator.Evaluate(taskID, title, description)
		if evalErr != nil {
			s.hub.Broadcast(Event{
				Type: "evaluate.failed",
				Data: map[string]string{
					"task_id": taskID,
					"error":   fmt.Sprintf("evaluate plan: %v", evalErr),
				},
			})
			return
		}

		s.hub.Broadcast(Event{
			Type: "evaluate.completed",
			Data: map[string]interface{}{
				"task_id":    taskID,
				"evaluation": result,
			},
		})
	}(resolved, tk.Title, tk.Description)
}

// POST /api/v1/tasks/{id}/breakdown
func (s *Server) handleBreakdownTask(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !requireMethod(w, r, http.MethodPost) {
		return
	}

	type breakdownReq struct {
		Tool  string `json:"tool"`
		Model string `json:"model"`
	}
	req, ok := decodeJSON[breakdownReq](w, r, true)
	if !ok {
		return
	}

	store := s.taskStore
	taskID, ok := resolveTaskID(w, store, id)
	if !ok {
		return
	}

	tk, err := store.Get(taskID)
	if err != nil {
		jsonError(w, err, http.StatusNotFound)
		return
	}
	if tk.Status != "pending" {
		jsonError(w, "task must be in pending status to breakdown", http.StatusBadRequest)
		return
	}

	if running, runErr := s.interactions.IsRunning(&taskID, interaction.PhaseBreakdown); runErr != nil {
		jsonError(w, runErr, http.StatusInternalServerError)
		return
	} else if running {
		jsonError(w, "breakdown already in progress", http.StatusConflict)
		return
	}

	toolName, toolDef, err := s.cfg.ResolveToolForPhase(interaction.PhasePlan, req.Tool)
	if err != nil {
		if strings.TrimSpace(req.Tool) != "" {
			jsonError(w, err, http.StatusBadRequest)
		} else {
			jsonError(w, err, http.StatusInternalServerError)
		}
		return
	}

	modelOverride := s.cfg.ResolveModelForPhase(interaction.PhasePlan, strings.TrimSpace(req.Model), toolName)
	jsonResponse(w, http.StatusAccepted, map[string]interface{}{
		"data": map[string]string{
			"task_id": taskID,
			"status":  "started",
		},
	})

	s.hub.Broadcast(Event{
		Type: "breakdown.started",
		Data: map[string]string{
			"task_id": taskID,
		},
	})

	go func(taskID, title, description string) {
		memStore := memory.NewStore(s.db)
		breaker := breakdown.New(toolName, toolDef, modelOverride, 10*time.Minute, s.repoDir, s.interactions).
			WithMemory(memStore).
			WithTaskStore(s.taskStore).
			WithSyncer(s.newMemorySyncer(memStore))
		proposed, interactionID, breakdownErr := breaker.Run(&taskID, strings.TrimSpace(title+"\n\n"+description))
		if breakdownErr != nil {
			s.hub.Broadcast(Event{
				Type: "breakdown.failed",
				Data: map[string]string{
					"task_id": taskID,
					"error":   breakdownErr.Error(),
				},
			})
			return
		}

		resultBytes, _ := json.Marshal(breakdownOperationResult{
			TaskID:   taskID,
			Proposed: proposed,
		})
		if interactionID != "" {
			if err := s.interactions.Finish(
				interactionID,
				"completed",
				interaction.WithQuality(string(resultBytes)),
			); err != nil {
				s.hub.Broadcast(Event{
					Type: "breakdown.failed",
					Data: map[string]string{
						"task_id": taskID,
						"error":   err.Error(),
					},
				})
				return
			}
		}

		data := map[string]interface{}{
			"task_id":  taskID,
			"proposed": proposed,
		}
		if interactionID != "" {
			data["interaction_id"] = interactionID
		}
		s.hub.Broadcast(Event{
			Type: "breakdown.completed",
			Data: data,
		})
	}(taskID, tk.Title, tk.Description)
}

// POST /api/v1/tasks/{id}/breakdown/accept
func (s *Server) handleAcceptBreakdown(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !requireMethod(w, r, http.MethodPost) {
		return
	}

	type acceptReq struct {
		InteractionID string                   `json:"interaction_id"`
		Tasks         []breakdown.ProposedTask `json:"tasks"`
	}
	req, ok := decodeJSON[acceptReq](w, r, false)
	if !ok {
		return
	}

	taskID, ok := resolveTaskID(w, s.taskStore, id)
	if !ok {
		return
	}
	tk, err := s.taskStore.Get(taskID)
	if err != nil {
		jsonError(w, err, http.StatusNotFound)
		return
	}
	if tk.Status != "pending" {
		jsonError(w, "task must be in pending status to accept breakdown", http.StatusBadRequest)
		return
	}

	interactionID := strings.TrimSpace(req.InteractionID)
	if interactionID == "" {
		jsonError(w, "interaction_id required", http.StatusBadRequest)
		return
	}
	in, err := s.interactions.Get(interactionID)
	if err != nil {
		jsonError(w, "breakdown interaction not found", http.StatusNotFound)
		return
	}
	if in.TaskID == nil || *in.TaskID != taskID || in.Phase != interaction.PhaseBreakdown || in.Status != "completed" {
		jsonError(w, "interaction_id must reference a completed breakdown interaction for this task", http.StatusBadRequest)
		return
	}

	result, err := parseBreakdownOperationResult(in.QualityJSON)
	if err != nil {
		jsonError(w, "invalid breakdown interaction result", http.StatusInternalServerError)
		return
	}
	if result.Accepted || result.Rejected {
		jsonError(w, "breakdown interaction already finalized", http.StatusBadRequest)
		return
	}

	proposed := result.Proposed
	if req.Tasks != nil {
		proposed = req.Tasks
	}
	if len(proposed) == 0 {
		jsonError(w, "no proposed tasks to accept", http.StatusBadRequest)
		return
	}

	createdIDs, err := s.createTasksFromProposedWithParent(proposed, taskID)
	if err != nil {
		jsonError(w, err, http.StatusInternalServerError)
		return
	}
	if err := s.taskStore.Update(taskID, task.UpdateFields{Status: task.Ptr("broken_down")}); err != nil {
		jsonError(w, err, http.StatusInternalServerError)
		return
	}

	result.TaskID = taskID
	result.Accepted = true
	result.Rejected = false
	result.CreatedTaskIDs = createdIDs
	resultBytes, _ := json.Marshal(result)
	if err := s.interactions.Finish(interactionID, "completed", interaction.WithQuality(string(resultBytes))); err != nil {
		jsonError(w, err, http.StatusInternalServerError)
		return
	}

	updatedParent, err := s.taskStore.Get(taskID)
	if err != nil {
		jsonError(w, err, http.StatusInternalServerError)
		return
	}
	s.hub.Broadcast(Event{Type: "task.updated", Data: updatedParent})
	for _, childID := range createdIDs {
		child, getErr := s.taskStore.Get(childID)
		if getErr != nil {
			continue
		}
		s.hub.Broadcast(Event{Type: "task.updated", Data: child})
	}

	jsonOK(w, map[string]interface{}{
		"task_id":        taskID,
		"interaction_id": interactionID,
		"created":        len(createdIDs),
		"task_ids":       createdIDs,
	})
}

// POST /api/v1/tasks/{id}/breakdown/reject
func (s *Server) handleRejectBreakdown(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !requireMethod(w, r, http.MethodPost) {
		return
	}

	type rejectReq struct {
		InteractionID string `json:"interaction_id"`
	}
	req, ok := decodeJSON[rejectReq](w, r, false)
	if !ok {
		return
	}

	taskID, ok := resolveTaskID(w, s.taskStore, id)
	if !ok {
		return
	}
	interactionID := strings.TrimSpace(req.InteractionID)
	if interactionID == "" {
		jsonError(w, "interaction_id required", http.StatusBadRequest)
		return
	}
	in, err := s.interactions.Get(interactionID)
	if err != nil {
		jsonError(w, "breakdown interaction not found", http.StatusNotFound)
		return
	}
	if in.TaskID == nil || *in.TaskID != taskID || in.Phase != interaction.PhaseBreakdown || in.Status != "completed" {
		jsonError(w, "interaction_id must reference a completed breakdown interaction for this task", http.StatusBadRequest)
		return
	}

	result, err := parseBreakdownOperationResult(in.QualityJSON)
	if err != nil {
		jsonError(w, "invalid breakdown interaction result", http.StatusInternalServerError)
		return
	}
	if result.Accepted || result.Rejected {
		jsonError(w, "breakdown interaction already finalized", http.StatusBadRequest)
		return
	}

	result.TaskID = taskID
	result.Rejected = true
	result.Accepted = false
	result.Proposed = nil
	result.CreatedTaskIDs = nil
	resultBytes, _ := json.Marshal(result)
	if err := s.interactions.Finish(interactionID, "completed", interaction.WithQuality(string(resultBytes))); err != nil {
		jsonError(w, err, http.StatusInternalServerError)
		return
	}

	s.hub.Broadcast(Event{
		Type: "breakdown.rejected",
		Data: map[string]interface{}{
			"task_id":        taskID,
			"interaction_id": interactionID,
			"rejected":       true,
		},
	})

	jsonOK(w, map[string]interface{}{
		"task_id":        taskID,
		"interaction_id": interactionID,
		"rejected":       true,
	})
}
