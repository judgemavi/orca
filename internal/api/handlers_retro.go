package api

import (
	"net/http"
	"strings"
	"time"

	"github.com/jasjeetmavi/orca/internal/interaction"
	"github.com/jasjeetmavi/orca/internal/knowledge"
	"github.com/jasjeetmavi/orca/internal/retro"
	"github.com/jasjeetmavi/orca/internal/task"
)

// ========== Retro ==========

// POST /api/v1/tasks/{id}/retro
func (s *Server) handleTaskRetro(w http.ResponseWriter, r *http.Request) {
	s.handleRetroTask(w, r)
}

// POST /api/v1/tasks/{id}/retro
func (s *Server) handleRetroTask(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !requireMethod(w, r, http.MethodPost) {
		return
	}

	type retroReq struct {
		Tool  string `json:"tool"`
		Model string `json:"model"`
	}
	req, ok := decodeJSON[retroReq](w, r, true)
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
	if tk.Status != "approved" && tk.Status != "merged" {
		jsonError(w, "task must be approved or merged to run retro", http.StatusBadRequest)
		return
	}

	interactionStore := interaction.NewStore(s.db, ".orca/interactions")
	if running, runErr := interactionStore.IsRunning(&taskID, interaction.PhaseRetro); runErr != nil {
		jsonError(w, runErr, http.StatusInternalServerError)
		return
	} else if running {
		jsonError(w, "retro already in progress", http.StatusConflict)
		return
	}

	if past, listErr := interactionStore.ListByPhase(taskID, interaction.PhaseRetro); listErr == nil {
		for _, ix := range past {
			if ix.Status == "completed" {
				jsonError(w, "retro already completed for this task", http.StatusConflict)
				return
			}
		}
	}

	toolOverride := strings.TrimSpace(req.Tool)
	modelOverride := strings.TrimSpace(req.Model)

	toolName, d, err := s.cfg.ResolveToolForPhase(interaction.PhaseRetro, toolOverride)
	if err != nil {
		if toolOverride != "" {
			jsonError(w, err, http.StatusBadRequest)
		} else {
			jsonError(w, err, http.StatusInternalServerError)
		}
		return
	}
	modelName := s.cfg.ResolveModelForPhase(interaction.PhaseRetro, modelOverride, d)

	jsonResponse(w, http.StatusAccepted, map[string]interface{}{
		"data": map[string]string{
			"task_id": taskID,
			"status":  "started",
		},
	})

	s.hub.Broadcast(Event{
		Type: "retro.started",
		Data: map[string]string{
			"task_id": taskID,
		},
	})

	go func(taskID string) {
		generator := retro.New(
			toolName,
			d,
			modelName,
			10*time.Minute,
			s.repoDir,
			knowledge.NewStore(s.db),
			task.NewStore(s.db),
			interaction.NewStore(s.db, ".orca/interactions"),
		)
		result, runErr := generator.Run(taskID)
		if runErr != nil {
			s.hub.Broadcast(Event{
				Type: "retro.failed",
				Data: map[string]string{
					"task_id": taskID,
					"error":   runErr.Error(),
				},
			})
			return
		}

		s.hub.Broadcast(Event{
			Type: "retro.completed",
			Data: map[string]interface{}{
				"task_id": taskID,
				"retro":   result,
			},
		})
	}(taskID)
}
