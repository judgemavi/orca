package api

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"path/filepath"
	"strings"

	"github.com/google/uuid"
	"github.com/jasjeetmavi/pod/internal/config"
	"github.com/jasjeetmavi/pod/internal/integrator"
	"github.com/jasjeetmavi/pod/internal/ops"
	"github.com/jasjeetmavi/pod/internal/task"
)

// ========== Integrate ==========

// POST /api/v1/tasks/{id}/merge
func (s *Server) handleMergeTask(w http.ResponseWriter, r *http.Request, id string) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Mode string `json:"mode"` // "" (default), "auto"
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil && err != io.EOF {
		jsonError(w, "invalid JSON", 400)
		return
	}

	store := task.NewStore(s.db)
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
	if tk.Status != "completed" {
		jsonError(w, "only completed tasks can be merged", 400)
		return
	}

	// Check that all dependencies are merged first.
	for _, depID := range tk.DependsOn {
		dep, err := store.Get(depID)
		if err != nil {
			jsonError(w, fmt.Sprintf("failed to check dependency %s: %v", depID[:8], err), 500)
			return
		}
		if dep.Status != "merged" {
			jsonError(w, fmt.Sprintf("dependency %q (%s) must be merged first", dep.Title, dep.ID[:8]), 400)
			return
		}
	}

	ig := integrator.New(s.repoDir, s.cfg.Project.IntegrationBranch, s.cfg.Validation.Commands)
	opID := uuid.New().String()
	if err := s.ops.Create(ops.Operation{
		ID:       opID,
		Type:     "merge",
		TargetID: resolved,
		Status:   "running",
	}); err != nil {
		jsonError(w, err, 500)
		return
	}

	mode := strings.TrimSpace(req.Mode)
	go func(taskID, mergeMode, operationID string) {
		defer func() {
			if rec := recover(); rec != nil {
				errMsg := fmt.Sprintf("merge panic: %v", rec)
				if opErr := s.ops.Fail(operationID, errMsg); opErr != nil {
					log.Printf("mark merge operation failed %s: %v", operationID, opErr)
				}
				s.hub.Broadcast(Event{Type: "merge.failed", Data: map[string]interface{}{
					"operation_id": operationID,
					"task_id":      taskID,
					"error":        errMsg,
				}})
			}
		}()

		s.hub.Broadcast(Event{Type: "merge.started", Data: map[string]interface{}{
			"operation_id": operationID,
			"task_id":      taskID,
			"mode":         mergeMode,
		}})

		var mergeErr error
		if mergeMode == "auto" {
			ig.SetRerunConfig(s.cfg.Project.WorktreeDir, func(id string) (config.ToolConfig, error) {
				return s.resolveToolConfigForTask(id)
			})
			s.hub.Broadcast(Event{Type: "merge.progress", Data: map[string]string{
				"task_id": taskID,
				"message": "Auto-resolving conflicts...",
			}})
			mergeErr = ig.MergeWithRerun(taskID)
		} else {
			mergeErr = ig.MergeAndValidate(taskID)
		}
		if mergeErr != nil {
			if opErr := s.ops.Fail(operationID, mergeErr.Error()); opErr != nil {
				log.Printf("mark merge operation failed %s: %v", operationID, opErr)
			}
			failData := map[string]interface{}{
				"operation_id": operationID,
				"task_id":      taskID,
				"error":        mergeErr.Error(),
			}
			if strings.Contains(strings.ToLower(mergeErr.Error()), "conflict") {
				failData["conflict"] = true
				failData["worktree_path"] = filepath.Join(s.cfg.Project.WorktreeDir, "task-"+taskID)
			}
			s.hub.Broadcast(Event{Type: "merge.failed", Data: failData})
			return
		}

		if err := store.Update(taskID, map[string]interface{}{"status": "merged"}); err != nil {
			if opErr := s.ops.Fail(operationID, err.Error()); opErr != nil {
				log.Printf("mark merge operation failed %s: %v", operationID, opErr)
			}
			s.hub.Broadcast(Event{Type: "merge.failed", Data: map[string]interface{}{
				"operation_id": operationID,
				"task_id":      taskID,
				"error":        err.Error(),
			}})
			return
		}
		if tk.SprintID != "" {
			if err := s.planner.CompleteSprintIfDone(tk.SprintID); err != nil {
				log.Printf("check sprint completion after merge %s: %v", tk.SprintID, err)
			}
		}
		if err := s.executor.Worktrees().Remove(taskID); err != nil {
			log.Printf("cleanup worktree after merge %s: %v", taskID[:8], err)
		}

		updated, getErr := store.Get(taskID)
		if getErr != nil {
			log.Printf("load task after merge %s: %v", taskID[:8], getErr)
			updated = &task.Task{ID: taskID, Status: "merged"}
		}
		resultBytes, _ := json.Marshal(updated)
		if err := s.ops.Complete(operationID, string(resultBytes)); err != nil {
			log.Printf("complete merge operation %s: %v", operationID, err)
		}
		s.hub.Broadcast(Event{Type: "merge.completed", Data: updated})
		s.hub.Broadcast(Event{Type: "task.updated", Data: updated})
	}(resolved, mode, opID)

	jsonResponse(w, http.StatusAccepted, map[string]interface{}{
		"data": map[string]string{"operation_id": opID},
	})
}

func (s *Server) resolveToolConfigForTask(taskID string) (config.ToolConfig, error) {
	store := task.NewStore(s.db)
	t, err := store.Get(taskID)
	if err != nil {
		return config.ToolConfig{}, err
	}

	name := t.AssignedTool
	if name != "" {
		if tc, ok := s.cfg.Tools[name]; ok {
			if model := validateIntegrateTaskModel(name, t.Model, tc); model != "" {
				tc.Model = model
			}
			return tc, nil
		}
		log.Printf("task assigned_tool %q not found in config, falling back to integrate phase default", name)
	}
	resolvedName, toolCfg, err := s.cfg.ResolvePhaseToolConfig("integrate")
	if err != nil {
		return config.ToolConfig{}, err
	}
	if model := validateIntegrateTaskModel(resolvedName, t.Model, toolCfg); model != "" {
		toolCfg.Model = model
	}
	return toolCfg, nil
}

func validateIntegrateTaskModel(toolName, model string, toolCfg config.ToolConfig) string {
	if model == "" {
		return ""
	}
	for _, m := range toolCfg.Models {
		if m == model {
			return model
		}
	}
	if toolName == "" {
		toolName = toolCfg.Binary
	}
	log.Printf("task model %q not in %s models list, using default", model, toolName)
	return ""
}

func (s *Server) handleIntegrate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		SprintID string `json:"sprint_id"`
	}
	json.NewDecoder(r.Body).Decode(&req)

	sprintID := req.SprintID
	if sprintID == "" {
		err := s.db.QueryRow(
			`SELECT id FROM sprints WHERE status IN ('completed', 'failed') ORDER BY completed_at DESC LIMIT 1`,
		).Scan(&sprintID)
		if err == sql.ErrNoRows {
			jsonError(w, "no completed sprints to integrate", 404)
			return
		}
		if err != nil {
			jsonError(w, err, 500)
			return
		}
	}

	if _, err := s.ops.GetByTarget("global", "integrate"); err == nil {
		jsonError(w, "integration already in progress", http.StatusConflict)
		return
	} else if !errors.Is(err, sql.ErrNoRows) {
		jsonError(w, err, 500)
		return
	}

	sp, err := s.planner.Get(sprintID)
	if err != nil {
		jsonError(w, err, 404)
		return
	}

	var taskIDs []string
	for _, id := range sp.TaskIDs {
		t, err := s.planner.GetTask(id)
		if err == nil && t.Status == "completed" {
			taskIDs = append(taskIDs, id)
		}
	}

	if len(taskIDs) == 0 {
		jsonError(w, "no completed tasks to integrate", 400)
		return
	}

	opID := uuid.New().String()
	if err := s.ops.Create(ops.Operation{
		ID:       opID,
		Type:     "integrate",
		TargetID: "global",
		Status:   "running",
	}); err != nil {
		jsonError(w, err, 500)
		return
	}

	jsonResponse(w, http.StatusAccepted, map[string]interface{}{
		"data": map[string]string{"operation_id": opID},
	})

	go func(operationID string, ids []string) {
		defer func() {
			if rec := recover(); rec != nil {
				errMsg := fmt.Sprintf("integrate panic: %v", rec)
				if opErr := s.ops.Fail(operationID, errMsg); opErr != nil {
					log.Printf("mark integrate operation failed %s: %v", operationID, opErr)
				}
				s.hub.Broadcast(Event{Type: "integrate.failed", Data: map[string]interface{}{
					"operation_id": operationID,
					"error":        errMsg,
				}})
			}
		}()

		ig := integrator.New(s.repoDir, s.cfg.Project.IntegrationBranch, s.cfg.Validation.Commands)
		store := task.NewStore(s.db)
		merged := make([]string, 0, len(ids))
		failed := make([]string, 0)

		s.hub.Broadcast(Event{Type: "integrate.started", Data: map[string]interface{}{
			"operation_id": operationID,
		}})

		for _, taskID := range ids {
			err := ig.MergeAndValidate(taskID)
			if err != nil {
				failed = append(failed, taskID)
				s.hub.Broadcast(Event{Type: "integrate.progress", Data: map[string]interface{}{
					"operation_id": operationID,
					"task_id":      taskID,
					"status":       "failed",
					"error":        err.Error(),
				}})
				continue
			}

			merged = append(merged, taskID)
			if err := store.Update(taskID, map[string]interface{}{"status": "merged"}); err != nil {
				log.Printf("set task %s merged: %v", taskID, err)
			}
			if err := s.executor.Worktrees().Remove(taskID); err != nil {
				log.Printf("cleanup worktree after integrate %s: %v", taskID[:8], err)
			}
			if updated, err := store.Get(taskID); err == nil {
				s.hub.Broadcast(Event{Type: "task.updated", Data: updated})
			}

			s.hub.Broadcast(Event{Type: "integrate.progress", Data: map[string]interface{}{
				"operation_id": operationID,
				"task_id":      taskID,
				"status":       "merged",
			}})
		}

		resultBytes, _ := json.Marshal(map[string]interface{}{
			"merged": merged,
			"failed": failed,
		})
		if err := s.ops.Complete(operationID, string(resultBytes)); err != nil {
			log.Printf("complete integrate operation %s: %v", operationID, err)
		}

		s.hub.Broadcast(Event{Type: "integrate.completed", Data: map[string]interface{}{
			"operation_id": operationID,
			"merged":       merged,
			"failed":       failed,
		}})
	}(opID, taskIDs)
}
