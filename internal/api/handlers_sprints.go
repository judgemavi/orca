package api

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/jasjeetmavi/orca/internal/ops"
)

// ========== Sprints ==========

func (s *Server) handleListSprints(w http.ResponseWriter, r *http.Request) {
	showAll := r.URL.Query().Get("all") == "true"
	query := `SELECT id, status, created_at, completed_at FROM sprints ORDER BY created_at DESC`
	if !showAll {
		query += ` LIMIT 10`
	}

	rows, err := s.db.Query(query)
	if err != nil {
		jsonError(w, err, 500)
		return
	}
	defer rows.Close()

	var sprints []map[string]interface{}
	for rows.Next() {
		var id, status string
		var createdAt time.Time
		var completedAt *time.Time
		if err := rows.Scan(&id, &status, &createdAt, &completedAt); err != nil {
			jsonError(w, err, 500)
			return
		}
		sp := map[string]interface{}{
			"id":         id,
			"status":     status,
			"created_at": createdAt,
		}
		if completedAt != nil {
			sp["completed_at"] = completedAt
		}
		sprints = append(sprints, sp)
	}
	jsonOK(w, map[string]interface{}{"sprints": sprints})
}

func (s *Server) handleGetActiveSprint(w http.ResponseWriter, r *http.Request) {
	active, err := s.planner.GetActive()
	if err != nil {
		jsonError(w, err, 500)
		return
	}
	if active == nil {
		jsonOK(w, nil)
		return
	}
	jsonOK(w, active)
}

func (s *Server) handleGetSprint(w http.ResponseWriter, r *http.Request, id string) {
	sp, err := s.planner.Get(id)
	if err != nil {
		jsonError(w, err, 404)
		return
	}
	jsonOK(w, sp)
}

func (s *Server) handlePlanSprint(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	active, err := s.planner.GetActive()
	if err != nil {
		jsonError(w, err, 500)
		return
	}
	if active != nil {
		jsonError(w, fmt.Sprintf("sprint %s already active", active.ID[:8]), 409)
		return
	}

	sp, err := s.planner.Plan(s.cfg.Workers.MaxParallel)
	if err != nil {
		jsonError(w, err, 400)
		return
	}

	s.hub.Broadcast(Event{Type: "sprint.planned", Data: sp})
	jsonOK(w, sp)
}

func (s *Server) handleSprintAssign(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		TaskID   string `json:"task_id"`
		SprintID string `json:"sprint_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, "invalid JSON", 400)
		return
	}
	if req.TaskID == "" {
		jsonError(w, "task_id required", 400)
		return
	}

	store := s.taskStore
	taskID, err := store.ResolveID(req.TaskID)
	if err != nil {
		jsonError(w, err, 404)
		return
	}

	sprintID := req.SprintID
	if sprintID == "" {
		active, err := s.planner.GetActive()
		if err != nil {
			jsonError(w, err, 500)
			return
		}
		if active == nil {
			active, err = s.planner.CreateEmpty()
			if err != nil {
				jsonError(w, err, 500)
				return
			}
		}
		if active.Status != "planning" {
			jsonError(w, "sprint is running, cannot add tasks", 400)
			return
		}
		sprintID = active.ID
	}

	if err := s.planner.AddTaskToSprintWithLimit(sprintID, taskID, s.cfg.Workers.MaxParallel); err != nil {
		jsonError(w, err, 400)
		return
	}

	sp, err := s.planner.Get(sprintID)
	if err != nil {
		jsonError(w, err, 500)
		return
	}

	s.hub.Broadcast(Event{Type: "sprint.updated", Data: sp})
	jsonOK(w, sp)
}

func (s *Server) handleSprintUnassign(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		TaskID string `json:"task_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, "invalid JSON", 400)
		return
	}
	if req.TaskID == "" {
		jsonError(w, "task_id required", 400)
		return
	}

	store := s.taskStore
	taskID, err := store.ResolveID(req.TaskID)
	if err != nil {
		jsonError(w, err, 404)
		return
	}

	tk, err := store.Get(taskID)
	if err != nil {
		jsonError(w, err, 404)
		return
	}
	if tk.SprintID == "" {
		jsonError(w, "task is not assigned to a sprint", 400)
		return
	}

	if err := s.planner.RemoveTaskFromSprint(tk.SprintID, taskID); err != nil {
		jsonError(w, err, 400)
		return
	}

	sp, err := s.planner.Get(tk.SprintID)
	if err != nil {
		jsonError(w, err, 500)
		return
	}

	s.hub.Broadcast(Event{Type: "sprint.updated", Data: sp})
	jsonOK(w, map[string]string{"status": "ok"})
}

func (s *Server) handleStartSprint(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	sp, err := s.planner.Get(id)
	if err != nil {
		jsonError(w, err, 404)
		return
	}

	opID := uuid.New().String()
	if err := s.ops.Create(ops.Operation{
		ID:       opID,
		Type:     "sprint_start",
		TargetID: id,
		Status:   "running",
	}); err != nil {
		jsonError(w, err, 500)
		return
	}

	jsonResponse(w, 202, map[string]interface{}{"data": map[string]string{"sprint_id": id}})

	go func() {
		defer func() {
			if rec := recover(); rec != nil {
				errMsg := fmt.Sprintf("sprint panic: %v", rec)
				if opErr := s.ops.Fail(opID, errMsg); opErr != nil {
					slog.Error("mark sprint operation failed", "operation_id", opID, "err", opErr)
				}
				slog.Error("sprint panicked", "sprint_id", id, "panic", rec)
				s.hub.Broadcast(Event{Type: "sprint.failed", Data: map[string]interface{}{"sprint_id": id, "error": errMsg}})
			}
		}()

		s.hub.Broadcast(Event{Type: "sprint.started", Data: map[string]string{"sprint_id": id}})

		results, err := s.executor.Run(sp)
		if err != nil {
			if opErr := s.ops.Fail(opID, err.Error()); opErr != nil {
				slog.Error("mark sprint operation failed", "operation_id", opID, "err", opErr)
			}
			slog.Error("sprint failed", "sprint_id", id, "err", err)
			s.hub.Broadcast(Event{Type: "sprint.failed", Data: map[string]interface{}{"sprint_id": id, "error": err.Error()}})
			return
		}

		resultBytes, _ := json.Marshal(map[string]interface{}{
			"sprint_id": id,
			"results":   results,
		})
		if err := s.ops.Complete(opID, string(resultBytes)); err != nil {
			slog.Debug("complete sprint operation failed", "operation_id", opID, "err", err)
		}

		s.hub.Broadcast(Event{Type: "sprint.completed", Data: map[string]interface{}{
			"sprint_id": id,
			"results":   results,
		}})
	}()
}

func (s *Server) handleCancelSprint(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	if err := s.executor.Cancel(); err != nil {
		jsonError(w, err, 500)
		return
	}

	sp, err := s.planner.Get(id)
	if err == nil {
		s.executor.Cleanup(sp)
		s.planner.ResetSprintTasks(id)
		s.planner.Fail(id)
	}

	s.hub.Broadcast(Event{Type: "sprint.cancelled", Data: map[string]string{"sprint_id": id}})
	jsonOK(w, map[string]string{"status": "cancelled", "sprint_id": id})
}

func (s *Server) handleResetSprint(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	sp, err := s.planner.Get(id)
	if err != nil {
		jsonError(w, err, 404)
		return
	}

	s.executor.Cleanup(sp)
	if err := s.planner.ResetSprintTasks(id); err != nil {
		jsonError(w, err, 500)
		return
	}
	s.planner.Fail(id)

	s.hub.Broadcast(Event{Type: "sprint.reset", Data: map[string]string{"sprint_id": id}})
	jsonOK(w, map[string]string{"status": "reset", "sprint_id": id})
}
