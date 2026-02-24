package api

import (
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	"github.com/jasjeetmavi/orca/internal/driver"
	"github.com/jasjeetmavi/orca/internal/model"
	"github.com/jasjeetmavi/orca/internal/task"
)

type createTaskReq struct {
	Title       string `json:"title"`
	Description string `json:"description"`
	ParentID    string `json:"parent_id"`
}

// ========== Task CRUD ==========

func (s *Server) handleListTasks(w http.ResponseWriter, r *http.Request) {
	store := s.taskStore
	status := r.URL.Query().Get("status")

	var tasks []*task.Task
	var err error
	if status != "" {
		tasks, err = store.ListByStatus(status)
	} else {
		tasks, err = store.List()
	}
	if err != nil {
		jsonError(w, err, http.StatusInternalServerError)
		return
	}
	jsonOK(w, map[string]interface{}{"tasks": tasks})
}

func (s *Server) handleGetTask(w http.ResponseWriter, r *http.Request, id string) {
	store := s.taskStore
	resolved, ok := resolveTaskID(w, store, id)
	if !ok {
		return
	}
	var err error
	t, err := store.Get(resolved)
	if err != nil {
		jsonError(w, err, http.StatusNotFound)
		return
	}
	jsonOK(w, t)
}

func (s *Server) handleCreateTask(w http.ResponseWriter, r *http.Request) {
	req, ok := decodeJSON[createTaskReq](w, r, false)
	if !ok {
		return
	}
	if req.Title == "" {
		jsonError(w, "title required", http.StatusBadRequest)
		return
	}
	store := s.taskStore
	t, err := store.Create(req.Title, req.Description, req.ParentID)
	if err != nil {
		jsonError(w, err, http.StatusInternalServerError)
		return
	}
	t, err = store.Get(t.ID)
	if err != nil {
		jsonError(w, err, http.StatusInternalServerError)
		return
	}

	s.hub.Broadcast(Event{Type: "task.created", Data: t})
	jsonResponse(w, 201, map[string]interface{}{"data": t})
}

func (s *Server) handleUpdateTask(w http.ResponseWriter, r *http.Request, id string) {
	store := s.taskStore
	resolved, ok := resolveTaskID(w, store, id)
	if !ok {
		return
	}
	var err error

	body, ok := decodeJSON[map[string]interface{}](w, r, false)
	if !ok {
		return
	}

	fields := make(map[string]interface{})
	for _, key := range []string{"title", "description", "status", "plan"} {
		if v, ok := body[key]; ok {
			fields[key] = v
		}
	}
	if len(fields) == 0 {
		jsonError(w, "no fields to update", http.StatusBadRequest)
		return
	}

	currentTask, err := store.Get(resolved)
	if err != nil {
		jsonError(w, err, http.StatusNotFound)
		return
	}

	if rawStatus, ok := fields["status"]; ok {
		newStatus, ok := rawStatus.(string)
		if !ok {
			jsonError(w, "status must be a string", http.StatusBadRequest)
			return
		}
		switch newStatus {
		case "pending":
			if currentTask.Status != "failed" {
				jsonError(w, "can only move failed tasks to pending", http.StatusBadRequest)
				return
			}
		case "planned", "approved", "running", "merged", "review":
			jsonError(w, "cannot manually set status to "+newStatus, http.StatusBadRequest)
			return
		}
	}

	if err := store.Update(resolved, fields); err != nil {
		jsonError(w, err, http.StatusInternalServerError)
		return
	}

	t, err := store.Get(resolved)
	if err != nil {
		jsonError(w, err, http.StatusInternalServerError)
		return
	}
	s.hub.Broadcast(Event{Type: "task.updated", Data: t})
	jsonOK(w, t)
}

func (s *Server) handleDeleteTask(w http.ResponseWriter, r *http.Request, id string) {
	store := s.taskStore
	resolved, ok := resolveTaskID(w, store, id)
	if !ok {
		return
	}
	if _, err := store.Get(resolved); err != nil {
		jsonError(w, err, http.StatusNotFound)
		return
	}

	if err := store.Delete(resolved); err != nil {
		jsonError(w, err, http.StatusBadRequest)
		return
	}
	// Best-effort worktree cleanup.
	if err := s.executor.Worktrees().Remove(resolved); err != nil {
		slog.Warn("cleanup worktree after delete", "task_id", resolved[:8], "err", err)
	}
	s.hub.Broadcast(Event{Type: "task.deleted", Data: map[string]string{"id": resolved}})
	jsonOK(w, map[string]string{"deleted": resolved})
}

func (s *Server) handleGetReady(w http.ResponseWriter, r *http.Request) {
	store := s.taskStore
	tasks, err := store.GetReady()
	if err != nil {
		jsonError(w, err, http.StatusInternalServerError)
		return
	}
	jsonOK(w, map[string]interface{}{"tasks": tasks})
}

func (s *Server) handleListModels(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	requestedTool := strings.TrimSpace(r.URL.Query().Get("tool"))

	if requestedTool != "" {
		d, ok := driver.Get(requestedTool)
		if !ok {
			jsonError(w, fmt.Sprintf("tool %q not found", requestedTool), http.StatusBadRequest)
			return
		}
		resp := map[string][]model.Model{
			requestedTool: model.FromDriver(requestedTool, d),
		}
		jsonOK(w, map[string]interface{}{"tools": resp})
		return
	}

	jsonOK(w, map[string]interface{}{"tools": model.AllFromConfig(s.cfg)})
}
