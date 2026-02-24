package api

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
)

// ========== Task Workflow ==========

// POST /api/v1/tasks/{id}/approve
func (s *Server) handleApproveTask(w http.ResponseWriter, r *http.Request, id string) {
	store := s.taskStore
	resolved, err := store.ResolveID(id)
	if err != nil {
		jsonError(w, err, 404)
		return
	}

	tk, err := store.Get(resolved)
	if err != nil {
		jsonError(w, err, 404)
		return
	}
	if tk.Status != "review" {
		jsonError(w, "task must be in review status to approve", 400)
		return
	}

	if err := store.Update(resolved, map[string]interface{}{"status": "approved"}); err != nil {
		jsonError(w, err, 500)
		return
	}
	if tk.SprintID != "" {
		if _, err := s.planner.CompleteSprintIfDone(tk.SprintID); err != nil {
			slog.Warn("check sprint completion after approve failed", "sprint_id", tk.SprintID, "err", err)
		}
	}

	updated, err := store.Get(resolved)
	if err != nil {
		jsonError(w, err, 500)
		return
	}

	s.hub.Broadcast(Event{Type: "task.updated", Data: updated})
	jsonOK(w, updated)
}

// POST /api/v1/tasks/{id}/request-changes
func (s *Server) handleRequestChanges(w http.ResponseWriter, r *http.Request, id string) {
	store := s.taskStore
	resolved, err := store.ResolveID(id)
	if err != nil {
		jsonError(w, err, 404)
		return
	}

	tk, err := store.Get(resolved)
	if err != nil {
		jsonError(w, err, 404)
		return
	}
	if tk.Status != "review" {
		jsonError(w, "task must be in review status to request changes", 400)
		return
	}

	type changesReq struct {
		Feedback string `json:"feedback"`
	}
	req, ok := decodeJSON[changesReq](w, r, false)
	if !ok {
		return
	}
	feedback := strings.TrimSpace(req.Feedback)
	if feedback == "" {
		jsonError(w, "feedback required", 400)
		return
	}

	if _, err := store.AddReview(resolved, feedback); err != nil {
		jsonError(w, err, 500)
		return
	}
	if err := store.Update(resolved, map[string]interface{}{"status": "running"}); err != nil {
		jsonError(w, err, 500)
		return
	}

	updated, err := store.Get(resolved)
	if err != nil {
		jsonError(w, err, 500)
		return
	}
	s.hub.Broadcast(Event{Type: "task.updated", Data: updated})

	go func(ctx context.Context, taskID string) {
		if err := s.executor.RunSingle(ctx, taskID); err != nil {
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
	resolved, err := store.ResolveID(id)
	if err != nil {
		jsonError(w, err, 404)
		return
	}
	reviews, err := store.ListReviews(resolved)
	if err != nil {
		jsonError(w, err, 500)
		return
	}
	jsonOK(w, map[string]interface{}{"reviews": reviews})
}

func (s *Server) handleReopenTask(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	store := s.taskStore
	resolved, err := store.ResolveID(id)
	if err != nil {
		jsonError(w, err, 404)
		return
	}

	tk, err := store.Get(resolved)
	if err != nil {
		jsonError(w, err, 404)
		return
	}
	if tk.Status != "failed" {
		jsonError(w, fmt.Sprintf("task %s is %q, not %q", resolved[:8], tk.Status, "failed"), 400)
		return
	}

	if err := store.Update(resolved, map[string]interface{}{"status": "pending", "sprint_id": nil}); err != nil {
		jsonError(w, err, 500)
		return
	}

	updated, err := store.Get(resolved)
	if err != nil {
		jsonError(w, err, 500)
		return
	}

	s.hub.Broadcast(Event{Type: "task.updated", Data: updated})
	jsonOK(w, updated)
}
