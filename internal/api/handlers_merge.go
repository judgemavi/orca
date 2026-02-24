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
	"github.com/jasjeetmavi/orca/internal/integrator"
	"github.com/jasjeetmavi/orca/internal/task"
	"github.com/jasjeetmavi/orca/internal/worktree"
)

// ========== Merge ==========

// POST /api/v1/tasks/{id}/merge
func (s *Server) handleMergeTask(w http.ResponseWriter, r *http.Request, id string) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}

	type mergeReq struct {
		Mode string `json:"mode"` // "" (default), "auto"
	}
	req, ok := decodeJSON[mergeReq](w, r, true)
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
	if tk.Status != "approved" {
		jsonError(w, "only approved tasks can be merged", http.StatusBadRequest)
		return
	}

	// Check that all dependencies are merged first.
	for _, depID := range tk.DependsOn {
		dep, err := store.Get(depID)
		if err != nil {
			jsonError(w, fmt.Sprintf("failed to check dependency %s: %v", depID[:8], err), http.StatusInternalServerError)
			return
		}
		if dep.Status != "merged" {
			jsonError(w, fmt.Sprintf("dependency %q (%s) must be merged first", dep.Title, dep.ID[:8]), http.StatusBadRequest)
			return
		}
	}

	ig := integrator.New(s.repoDir, s.cfg.Project.IntegrationBranch, s.cfg.Validation.Commands)
	mode := strings.TrimSpace(req.Mode)
	opID := ""
	opID = s.startAsyncOp(
		w,
		"merge",
		resolved,
		"merge",
		map[string]interface{}{"operation_id": "", "task_id": resolved},
		map[string]string{"operation_id": ""},
		func() {
			taskID := resolved
			operationID := opID

			s.hub.Broadcast(Event{Type: "merge.started", Data: map[string]interface{}{
				"operation_id": operationID,
				"task_id":      taskID,
				"mode":         mode,
			}})

			var mergeErr error
			if mode == "auto" {
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
					slog.Error("mark merge operation failed", "operation_id", operationID, "err", opErr)
				}
				failData := map[string]interface{}{
					"operation_id": operationID,
					"task_id":      taskID,
					"error":        mergeErr.Error(),
				}
				if strings.Contains(strings.ToLower(mergeErr.Error()), "conflict") {
					failData["conflict"] = true
					failData["worktree_path"] = worktree.ResolveTaskDir(s.cfg.Project.WorktreeDir, taskID)
				}
				s.hub.Broadcast(Event{Type: "merge.failed", Data: failData})
				return
			}

			if err := store.Update(taskID, map[string]interface{}{"status": "merged"}); err != nil {
				if opErr := s.ops.Fail(operationID, err.Error()); opErr != nil {
					slog.Error("mark merge operation failed", "operation_id", operationID, "err", opErr)
				}
				s.hub.Broadcast(Event{Type: "merge.failed", Data: map[string]interface{}{
					"operation_id": operationID,
					"task_id":      taskID,
					"error":        err.Error(),
				}})
				return
			}
			if err := s.executor.Worktrees().Remove(taskID); err != nil {
				slog.Warn("cleanup worktree after merge failed", "task_id", taskID, "err", err)
			}

			updated, getErr := store.Get(taskID)
			if getErr != nil {
				slog.Warn("load task after merge failed", "task_id", taskID, "err", getErr)
				updated = &task.Task{ID: taskID, Status: "merged"}
			}
			resultBytes, _ := json.Marshal(updated)
			if err := s.ops.Complete(operationID, string(resultBytes)); err != nil {
				slog.Debug("complete merge operation failed", "operation_id", operationID, "err", err)
			}
			s.hub.Broadcast(Event{Type: "merge.completed", Data: updated})
			s.hub.Broadcast(Event{Type: "task.updated", Data: updated})
		},
	)
	if opID == "" {
		return
	}
}

func (s *Server) resolveToolConfigForTask(taskID string) (config.ToolConfig, error) {
	store := s.taskStore
	t, err := store.Get(taskID)
	if err != nil {
		return config.ToolConfig{}, err
	}

	_, toolCfg, err := s.cfg.ResolveToolForPhase(t, "merge", "")
	if err != nil {
		return config.ToolConfig{}, err
	}
	return toolCfg, nil
}

func (s *Server) handleMerge(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}

	if _, ok := decodeJSON[map[string]interface{}](w, r, true); !ok {
		return
	}

	if _, err := s.ops.GetByTarget("global", "merge"); err == nil {
		jsonError(w, "merge already in progress", http.StatusConflict)
		return
	} else if !errors.Is(err, sql.ErrNoRows) {
		jsonError(w, err, http.StatusInternalServerError)
		return
	}

	store := s.taskStore
	approved, err := store.ListByStatus("approved")
	if err != nil {
		jsonError(w, err, http.StatusInternalServerError)
		return
	}

	taskIDs := make([]string, 0, len(approved))
	for _, tk := range approved {
		taskIDs = append(taskIDs, tk.ID)
	}

	if len(taskIDs) == 0 {
		jsonError(w, "no approved tasks to merge", http.StatusBadRequest)
		return
	}

	opID := ""
	opID = s.startAsyncOp(
		w,
		"merge",
		"global",
		"merge",
		map[string]interface{}{"operation_id": ""},
		map[string]string{"operation_id": ""},
		func() {
			operationID := opID
			ig := integrator.New(s.repoDir, s.cfg.Project.IntegrationBranch, s.cfg.Validation.Commands)
			merged := make([]string, 0, len(taskIDs))
			failed := make([]string, 0)

			s.hub.Broadcast(Event{Type: "merge.started", Data: map[string]interface{}{
				"operation_id": operationID,
			}})

			for _, taskID := range taskIDs {
				err := ig.MergeAndValidate(taskID)
				if err != nil {
					failed = append(failed, taskID)
					s.hub.Broadcast(Event{Type: "merge.progress", Data: map[string]interface{}{
						"operation_id": operationID,
						"task_id":      taskID,
						"status":       "failed",
						"error":        err.Error(),
					}})
					continue
				}

				merged = append(merged, taskID)
				if err := store.Update(taskID, map[string]interface{}{"status": "merged"}); err != nil {
					slog.Warn("set task merged failed", "task_id", taskID, "err", err)
				}
				if err := s.executor.Worktrees().Remove(taskID); err != nil {
					slog.Warn("cleanup worktree after merge failed", "task_id", taskID, "err", err)
				}
				if updated, err := store.Get(taskID); err == nil {
					s.hub.Broadcast(Event{Type: "task.updated", Data: updated})
				}

				s.hub.Broadcast(Event{Type: "merge.progress", Data: map[string]interface{}{
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
				slog.Debug("complete merge operation failed", "operation_id", operationID, "err", err)
			}

			s.hub.Broadcast(Event{Type: "merge.completed", Data: map[string]interface{}{
				"operation_id": operationID,
				"merged":       merged,
				"failed":       failed,
			}})
		},
	)
	if opID == "" {
		return
	}
}
