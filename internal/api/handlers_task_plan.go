package api

import (
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/jasjeetmavi/orca/internal/evaluate"
	"github.com/jasjeetmavi/orca/internal/plan"
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
		if in.TaskID == nil || *in.TaskID != resolved || in.Phase != "plan" || in.Status != "completed" {
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
	if running, err := s.interactions.IsRunning(&taskID, "plan"); err != nil {
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

	toolName, d, err := s.cfg.ResolveToolForPhase("plan", tool)
	if err != nil {
		if tool != "" {
			return http.StatusBadRequest, err
		}
		return http.StatusInternalServerError, err
	}
	modelOverride := s.cfg.ResolveModelForPhase("plan", model, d)

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
		generator := plan.New(toolName, d, modelOverride, 10*time.Minute, s.repoDir, s.interactions)
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

	toolName, d, err := s.cfg.ResolveToolForPhase("explore", req.Tool)
	if err != nil {
		if strings.TrimSpace(req.Tool) != "" {
			jsonError(w, err, http.StatusBadRequest)
		} else {
			jsonError(w, err, http.StatusInternalServerError)
		}
		return
	}

	modelOverride := s.cfg.ResolveModelForPhase("explore", strings.TrimSpace(req.Model), d)
	evaluator := evaluate.New(toolName, d, modelOverride, 10*time.Minute, s.repoDir, s.interactions)

	var result *evaluate.EvaluationResult
	result, err = evaluator.Evaluate(resolved, tk.Title, tk.Description)
	if err != nil {
		jsonError(w, fmt.Sprintf("evaluate plan: %v", err), http.StatusInternalServerError)
		return
	}

	jsonOK(w, map[string]interface{}{
		"task_id":    resolved,
		"evaluation": result,
	})
}
