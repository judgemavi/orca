package api

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	"github.com/jasjeetmavi/orca/internal/config"
	"github.com/jasjeetmavi/orca/internal/evaluate"
	"github.com/jasjeetmavi/orca/internal/plan"
)

// ========== Task Plans ==========

func (s *Server) handleGetTaskPlan(w http.ResponseWriter, r *http.Request, id string) {
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

func (s *Server) handlePutTaskPlan(w http.ResponseWriter, r *http.Request, id string) {
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

func (s *Server) handleGenerateTaskPlan(w http.ResponseWriter, r *http.Request, id string) {
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
	var err error
	if _, err := s.ops.GetByTarget(resolved, "plan_generate"); err == nil {
		jsonError(w, "plan generation already in progress", http.StatusConflict)
		return
	} else if !errors.Is(err, sql.ErrNoRows) {
		jsonError(w, err, http.StatusInternalServerError)
		return
	}

	tk, err := store.Get(resolved)
	if err != nil {
		jsonError(w, err, http.StatusNotFound)
		return
	}

	toolName, toolCfg, err := s.cfg.ResolveToolForPhase("plan", req.Tool)
	if err != nil {
		if strings.TrimSpace(req.Tool) != "" {
			jsonError(w, err, http.StatusBadRequest)
		} else {
			jsonError(w, err, http.StatusInternalServerError)
		}
		return
	}

	modelOverride := config.ValidateModel(toolName, req.Model, toolCfg)
	if modelOverride == "" {
		modelOverride = toolCfg.Model
	}

	s.hub.Broadcast(Event{
		Type: "plan.generating",
		Data: map[string]string{"task_id": resolved},
	})

	opID := ""
	opID = s.startAsyncOp(
		w,
		"plan_generate",
		resolved,
		"plan",
		map[string]interface{}{"task_id": resolved},
		map[string]string{"status": "generating"},
		func() {
			taskID := resolved
			generator := plan.New(toolCfg, s.repoDir)
			var content string
			var genErr error
			if modelOverride != "" {
				content, genErr = generator.GenerateWithModel(tk.Title, tk.Description, modelOverride)
			} else {
				content, genErr = generator.Generate(tk.Title, tk.Description)
			}
			if genErr != nil {
				if err := s.ops.Fail(opID, genErr.Error()); err != nil {
					slog.Error("mark plan operation failed", "operation_id", opID, "err", err)
				}
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
				if opErr := s.ops.Fail(opID, err.Error()); opErr != nil {
					slog.Error("mark plan operation failed", "operation_id", opID, "err", opErr)
				}
				s.hub.Broadcast(Event{
					Type: "plan.failed",
					Data: map[string]string{
						"task_id": taskID,
						"error":   err.Error(),
					},
				})
				return
			}

			resultBytes, _ := json.Marshal(map[string]string{
				"task_id": taskID,
				"plan":    content,
			})
			if err := s.ops.Complete(opID, string(resultBytes)); err != nil {
				slog.Debug("complete plan operation failed", "operation_id", opID, "err", err)
			}

			s.hub.Broadcast(Event{
				Type: "plan.completed",
				Data: map[string]string{
					"task_id": taskID,
					"plan":    content,
				},
			})
		},
	)
	if opID == "" {
		return
	}
}

// POST /api/v1/tasks/{id}/evaluate
func (s *Server) handleEvaluateTask(w http.ResponseWriter, r *http.Request, id string) {
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

	_, toolCfg, err := s.cfg.ResolveToolForPhase("explore", req.Tool)
	if err != nil {
		if strings.TrimSpace(req.Tool) != "" {
			jsonError(w, err, http.StatusBadRequest)
		} else {
			jsonError(w, err, http.StatusInternalServerError)
		}
		return
	}

	evaluator := evaluate.New(toolCfg, s.repoDir)
	modelOverride := strings.TrimSpace(req.Model)

	var result *evaluate.EvaluationResult
	if modelOverride != "" {
		result, err = evaluator.EvaluateWithModel(tk.Title, tk.Description, modelOverride)
	} else {
		result, err = evaluator.Evaluate(tk.Title, tk.Description)
	}
	if err != nil {
		jsonError(w, fmt.Sprintf("evaluate plan: %v", err), http.StatusInternalServerError)
		return
	}

	jsonOK(w, map[string]interface{}{
		"task_id":    resolved,
		"evaluation": result,
	})
}
