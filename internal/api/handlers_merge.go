package api

import (
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/jasjeetmavi/orca/internal/driver"
	"github.com/jasjeetmavi/orca/internal/integrator"
	"github.com/jasjeetmavi/orca/internal/task"
	"github.com/jasjeetmavi/orca/internal/worktree"
)

// ========== Merge ==========

// POST /api/v1/tasks/{id}/merge
func (s *Server) handleMergeTask(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}

	type mergeReq struct {
		Mode  string `json:"mode"` // "" (default), "auto"
		Tool  string `json:"tool"`
		Model string `json:"model"`
	}
	req, ok := decodeJSON[mergeReq](w, r, true)
	if !ok {
		return
	}

	s.withTaskValidation("only approved tasks can be merged", []string{"approved"}, func(w http.ResponseWriter, r *http.Request, tk *task.Task) {
		store := s.taskStore

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

		ig := integrator.New(s.repoDir, s.cfg.Project.IntegrationBranch, s.cfg.Validation.Commands, s.interactions)
		mode := strings.TrimSpace(req.Mode)
		s.runAsyncHandler(w, "merge", map[string]string{"status": "merging"}, func() {
			taskID := tk.ID

			s.hub.Broadcast(Event{Type: "merge.started", Data: map[string]interface{}{
				"task_id": taskID,
				"mode":    mode,
			}})

			var mergeErr error
			if mode == "auto" {
				ig.SetRerunConfig(s.cfg.Project.WorktreeDir, func(id string) (string, driver.Driver, string, time.Duration, error) {
					return s.resolveToolConfigForTask(id, req.Tool, req.Model)
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
				failData := map[string]interface{}{
					"task_id": taskID,
					"error":   mergeErr.Error(),
				}
				if strings.Contains(strings.ToLower(mergeErr.Error()), "conflict") {
					failData["conflict"] = true
					failData["worktree_path"] = worktree.ResolveTaskDir(s.cfg.Project.WorktreeDir, taskID)
				}
				s.hub.Broadcast(Event{Type: "merge.failed", Data: failData})
				return
			}

			if err := store.Update(taskID, map[string]interface{}{"status": "merged"}); err != nil {
				s.hub.Broadcast(Event{Type: "merge.failed", Data: map[string]interface{}{
					"task_id": taskID,
					"error":   err.Error(),
				}})
				return
			}
			if err := s.executor.Worktrees().Remove(taskID); err != nil {
				slog.Warn("cleanup worktree after merge failed", "task_id", taskID, "err", err)
			}

			updated, getErr := store.Get(taskID)
			if getErr != nil {
				updated = &task.Task{ID: taskID, Status: "merged"}
			}
			s.hub.Broadcast(Event{Type: "merge.completed", Data: updated})
			s.hub.Broadcast(Event{Type: "task.updated", Data: updated})
		})
	})(w, r)
}

func (s *Server) resolveToolConfigForTask(taskID string, toolOverride string, modelOverride string) (string, driver.Driver, string, time.Duration, error) {
	if _, err := s.taskStore.Get(taskID); err != nil {
		return "", nil, "", 0, err
	}

	toolName, d, err := s.cfg.ResolveToolForPhase("merge", toolOverride)
	if err != nil {
		return "", nil, "", 0, err
	}
	model := s.cfg.ResolveModelForPhase("merge", modelOverride, d)
	return toolName, d, model, 10 * time.Minute, nil
}

func (s *Server) handleMerge(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}

	if _, ok := decodeJSON[map[string]interface{}](w, r, true); !ok {
		return
	}

	if running, err := s.interactions.IsRunning(nil, "merge"); err != nil {
		jsonError(w, err, http.StatusInternalServerError)
		return
	} else if running {
		jsonError(w, "merge already in progress", http.StatusConflict)
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

	s.runAsyncHandler(w, "merge", map[string]string{"status": "merging"}, func() {
		ig := integrator.New(s.repoDir, s.cfg.Project.IntegrationBranch, s.cfg.Validation.Commands, s.interactions)
		merged := make([]string, 0, len(taskIDs))
		failed := make([]string, 0)

		s.hub.Broadcast(Event{Type: "merge.started", Data: map[string]interface{}{}})

		for _, taskID := range taskIDs {
			err := ig.MergeAndValidate(taskID)
			if err != nil {
				failed = append(failed, taskID)
				s.hub.Broadcast(Event{Type: "merge.progress", Data: map[string]interface{}{
					"task_id": taskID,
					"status":  "failed",
					"error":   err.Error(),
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
				"task_id": taskID,
				"status":  "merged",
			}})
		}

		s.hub.Broadcast(Event{Type: "merge.completed", Data: map[string]interface{}{
			"merged": merged,
			"failed": failed,
		}})
	})
}
