package api

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	"github.com/jasjeetmavi/orca/internal/executor"
)

// ========== Task Workflow ==========

// POST /api/v1/tasks/{id}/approve-plan
func (s *Server) handleApprovePlan(w http.ResponseWriter, r *http.Request, id string) {
	if !requireMethod(w, r, http.MethodPost) {
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
		jsonError(w, "task must be in pending status to approve plan", http.StatusBadRequest)
		return
	}
	if strings.TrimSpace(tk.Plan) == "" {
		jsonError(w, "task must have a plan to approve", http.StatusBadRequest)
		return
	}

	if err := store.Update(resolved, map[string]interface{}{"status": "planned"}); err != nil {
		jsonError(w, err, http.StatusInternalServerError)
		return
	}

	updated, err := store.Get(resolved)
	if err != nil {
		jsonError(w, err, http.StatusInternalServerError)
		return
	}

	s.hub.Broadcast(Event{Type: "task.updated", Data: updated})
	jsonOK(w, updated)
}

// POST /api/v1/tasks/{id}/approve
func (s *Server) handleApproveTask(w http.ResponseWriter, r *http.Request, id string) {
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
	if tk.Status != "review" {
		jsonError(w, "task must be in review status to approve", http.StatusBadRequest)
		return
	}

	if err := store.Update(resolved, map[string]interface{}{"status": "approved"}); err != nil {
		jsonError(w, err, http.StatusInternalServerError)
		return
	}

	updated, err := store.Get(resolved)
	if err != nil {
		jsonError(w, err, http.StatusInternalServerError)
		return
	}

	s.hub.Broadcast(Event{Type: "task.updated", Data: updated})
	jsonOK(w, updated)
}

// POST /api/v1/tasks/{id}/request-changes
func (s *Server) handleRequestChanges(w http.ResponseWriter, r *http.Request, id string) {
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
	if tk.Status != "review" {
		jsonError(w, "task must be in review status to request changes", http.StatusBadRequest)
		return
	}

	type changesReq struct {
		Feedback      string `json:"feedback"`
		InteractionID string `json:"interaction_id"`
		Tool          string `json:"tool"`
		Model         string `json:"model"`
	}
	req, ok := decodeJSON[changesReq](w, r, false)
	if !ok {
		return
	}
	feedback := strings.TrimSpace(req.Feedback)
	interactionID := strings.TrimSpace(req.InteractionID)
	tool := strings.TrimSpace(req.Tool)
	model := strings.TrimSpace(req.Model)
	if feedback == "" {
		jsonError(w, "feedback required", http.StatusBadRequest)
		return
	}

	if _, err := store.AddReview(resolved, feedback, interactionID); err != nil {
		jsonError(w, err, http.StatusInternalServerError)
		return
	}
	if err := store.Update(resolved, map[string]interface{}{"status": "running"}); err != nil {
		jsonError(w, err, http.StatusInternalServerError)
		return
	}

	updated, err := store.Get(resolved)
	if err != nil {
		jsonError(w, err, http.StatusInternalServerError)
		return
	}
	s.hub.Broadcast(Event{Type: "task.updated", Data: updated})

	go func(ctx context.Context, taskID string) {
		if err := s.executor.RunSingleWithOpts(ctx, taskID, executor.RunOpts{
			ToolOverride:  tool,
			ModelOverride: model,
		}); err != nil {
			slog.Error("request changes rerun failed", "task_id", taskID, "err", err)
		}
	}(s.ctx, resolved)

	jsonResponse(w, http.StatusAccepted, map[string]interface{}{
		"status":  "running",
		"task_id": resolved,
	})
}

func (s *Server) handleListTaskReviews(w http.ResponseWriter, r *http.Request, id string) {
	store := s.taskStore
	resolved, ok := resolveTaskID(w, store, id)
	if !ok {
		return
	}
	var err error
	reviews, err := store.ListReviews(resolved)
	if err != nil {
		jsonError(w, err, http.StatusInternalServerError)
		return
	}
	jsonOK(w, map[string]interface{}{"reviews": reviews})
}

func (s *Server) handleReopenTask(w http.ResponseWriter, r *http.Request, id string) {
	if !requireMethod(w, r, http.MethodPost) {
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
	if tk.Status != "failed" {
		jsonError(w, fmt.Sprintf("task %s is %q, not %q", resolved[:8], tk.Status, "failed"), http.StatusBadRequest)
		return
	}

	if err := store.Update(resolved, map[string]interface{}{"status": "pending"}); err != nil {
		jsonError(w, err, http.StatusInternalServerError)
		return
	}

	updated, err := store.Get(resolved)
	if err != nil {
		jsonError(w, err, http.StatusInternalServerError)
		return
	}

	s.hub.Broadcast(Event{Type: "task.updated", Data: updated})
	jsonOK(w, updated)
}
