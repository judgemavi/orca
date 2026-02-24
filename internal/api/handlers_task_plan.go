package api

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jasjeetmavi/orca/internal/config"
	"github.com/jasjeetmavi/orca/internal/evaluate"
	"github.com/jasjeetmavi/orca/internal/ops"
	"github.com/jasjeetmavi/orca/internal/plan"
)

// ========== Task Plans ==========

func (s *Server) handleGetTaskPlan(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	store := s.taskStore
	resolved, err := store.ResolveID(id)
	if err != nil {
		jsonError(w, err, 404)
		return
	}

	content, err := store.GetPlan(resolved)
	if err != nil {
		jsonError(w, err, 500)
		return
	}

	jsonOK(w, map[string]string{"plan": content})
}

func (s *Server) handlePutTaskPlan(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodPut {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
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
	resolved, err := store.ResolveID(id)
	if err != nil {
		jsonError(w, err, 404)
		return
	}

	if err := store.SetPlan(resolved, req.Plan); err != nil {
		jsonError(w, err, 500)
		return
	}

	jsonOK(w, map[string]string{"plan": req.Plan})
}

func (s *Server) handleGenerateTaskPlan(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
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
	resolved, err := store.ResolveID(id)
	if err != nil {
		jsonError(w, err, 404)
		return
	}
	if _, err := s.ops.GetByTarget(resolved, "plan_generate"); err == nil {
		jsonError(w, "plan generation already in progress", http.StatusConflict)
		return
	} else if !errors.Is(err, sql.ErrNoRows) {
		jsonError(w, err, 500)
		return
	}

	tk, err := store.Get(resolved)
	if err != nil {
		jsonError(w, err, 404)
		return
	}

	toolName, toolCfg, err := s.cfg.ResolveToolForPhase(tk, "plan", req.Tool)
	if err != nil {
		if strings.TrimSpace(req.Tool) != "" {
			jsonError(w, err, 400)
		} else {
			jsonError(w, err, 500)
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

	opID := uuid.New().String()
	if err := s.ops.Create(ops.Operation{
		ID:       opID,
		Type:     "plan_generate",
		TargetID: resolved,
		Status:   "running",
	}); err != nil {
		jsonError(w, err, 500)
		return
	}

	s.runAsync(opID, "plan", map[string]interface{}{"task_id": resolved}, func() {
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
	})

	jsonResponse(w, http.StatusAccepted, map[string]interface{}{
		"data": map[string]string{"status": "generating"},
	})
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

	toolName := strings.TrimSpace(req.Tool)
	if toolName == "" {
		toolName = strings.TrimSpace(tk.AssignedTool)
	}
	if toolName == "" {
		toolName = strings.TrimSpace(s.cfg.Defaults.Tool)
	}
	if toolName == "" {
		for name := range s.cfg.Tools {
			toolName = name
			break
		}
	}
	if toolName == "" {
		jsonError(w, "no tools configured", 500)
		return
	}

	toolCfg, ok := s.cfg.Tools[toolName]
	if !ok {
		jsonError(w, fmt.Sprintf("tool %q not found in config", toolName), 500)
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
		jsonError(w, fmt.Sprintf("evaluate plan: %v", err), 500)
		return
	}

	jsonOK(w, map[string]interface{}{
		"task_id":    resolved,
		"evaluation": result,
	})
}
