package api

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	"github.com/jasjeetmavi/orca/internal/model"
	"github.com/jasjeetmavi/orca/internal/task"
)

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
		jsonError(w, err, 500)
		return
	}
	jsonOK(w, map[string]interface{}{"tasks": tasks})
}

func (s *Server) handleGetTask(w http.ResponseWriter, r *http.Request, id string) {
	store := s.taskStore
	resolved, err := store.ResolveID(id)
	if err != nil {
		jsonError(w, err, 404)
		return
	}
	t, err := store.Get(resolved)
	if err != nil {
		jsonError(w, err, 404)
		return
	}
	jsonOK(w, t)
}

func (s *Server) handleCreateTask(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Title        string               `json:"title"`
		Description  string               `json:"description"`
		ParentID     string               `json:"parent_id"`
		Tool         string               `json:"tool"`
		AssignedTool string               `json:"assigned_tool"`
		Model        string               `json:"model"`
		PhaseConfig  *task.PhaseConfigMap `json:"phase_config,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, "invalid JSON", 400)
		return
	}
	if req.Title == "" {
		jsonError(w, "title required", 400)
		return
	}
	toolName := strings.TrimSpace(req.Tool)
	if toolName == "" {
		toolName = strings.TrimSpace(req.AssignedTool)
	}

	store := s.taskStore
	t, err := store.Create(req.Title, req.Description, req.ParentID, toolName)
	if err != nil {
		jsonError(w, err, 500)
		return
	}
	if req.Model != "" {
		if err := store.Update(t.ID, map[string]interface{}{"model": req.Model}); err != nil {
			jsonError(w, err, 500)
			return
		}
	}
	if req.PhaseConfig != nil {
		data, err := json.Marshal(req.PhaseConfig)
		if err != nil {
			jsonError(w, err, 500)
			return
		}
		if err := store.Update(t.ID, map[string]interface{}{"phase_config": string(data)}); err != nil {
			jsonError(w, err, 500)
			return
		}
	}
	t, err = store.Get(t.ID)
	if err != nil {
		jsonError(w, err, 500)
		return
	}

	s.hub.Broadcast(Event{Type: "task.created", Data: t})
	jsonResponse(w, 201, map[string]interface{}{"data": t})
}

func (s *Server) handleUpdateTask(w http.ResponseWriter, r *http.Request, id string) {
	store := s.taskStore
	resolved, err := store.ResolveID(id)
	if err != nil {
		jsonError(w, err, 404)
		return
	}

	var body map[string]interface{}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		jsonError(w, "invalid JSON", 400)
		return
	}

	fields := make(map[string]interface{})
	for _, key := range []string{"title", "description", "prompt", "status", "assigned_tool", "model", "phase_config"} {
		if v, ok := body[key]; ok {
			fields[key] = v
		}
	}
	if v, ok := fields["phase_config"]; ok && v != nil {
		data, err := json.Marshal(v)
		if err == nil {
			fields["phase_config"] = string(data)
		}
	}
	if len(fields) == 0 {
		jsonError(w, "no fields to update", 400)
		return
	}

	currentTask, err := store.Get(resolved)
	if err != nil {
		jsonError(w, err, 404)
		return
	}

	if rawStatus, ok := fields["status"]; ok {
		newStatus, ok := rawStatus.(string)
		if !ok {
			jsonError(w, "status must be a string", 400)
			return
		}
		switch newStatus {
		case "pending":
			if currentTask.Status != "failed" {
				jsonError(w, "can only move failed tasks to pending", 400)
				return
			}
		case "in_sprint":
			jsonError(w, "use /api/v1/sprints/assign to add tasks to sprint", 400)
			return
		case "approved", "running", "merged", "review":
			jsonError(w, "cannot manually set status to "+newStatus, 400)
			return
		}
	}

	if err := store.Update(resolved, fields); err != nil {
		jsonError(w, err, 500)
		return
	}

	t, err := store.Get(resolved)
	if err != nil {
		jsonError(w, err, 500)
		return
	}
	s.hub.Broadcast(Event{Type: "task.updated", Data: t})
	jsonOK(w, t)
}

func (s *Server) handleDeleteTask(w http.ResponseWriter, r *http.Request, id string) {
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

	sprintID := tk.SprintID
	if err := store.Delete(resolved); err != nil {
		jsonError(w, err, 400)
		return
	}
	// Best-effort worktree cleanup.
	if err := s.executor.Worktrees().Remove(resolved); err != nil {
		slog.Warn("cleanup worktree after delete", "task_id", resolved[:8], "err", err)
	}
	// End sprint if all its tasks have been deleted.
	if sprintID != "" {
		if _, err := s.planner.CompleteSprintIfDone(sprintID); err != nil {
			slog.Warn("check sprint after delete", "sprint_id", sprintID[:8], "err", err)
		}
	}

	s.hub.Broadcast(Event{Type: "task.deleted", Data: map[string]string{"id": resolved}})
	jsonOK(w, map[string]string{"deleted": resolved})
}

func (s *Server) handleGetReady(w http.ResponseWriter, r *http.Request) {
	store := s.taskStore
	tasks, err := store.GetReady()
	if err != nil {
		jsonError(w, err, 500)
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
		toolCfg, ok := s.cfg.Tools[requestedTool]
		if !ok {
			jsonError(w, fmt.Sprintf("tool %q not found", requestedTool), 400)
			return
		}
		resp := map[string][]model.Model{
			requestedTool: model.FromConfig(requestedTool, toolCfg),
		}
		jsonOK(w, map[string]interface{}{"tools": resp})
		return
	}

	jsonOK(w, map[string]interface{}{"tools": model.AllFromConfig(s.cfg)})
}
