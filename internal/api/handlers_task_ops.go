package api

import (
	"fmt"
	"net/http"
	"strings"

	"github.com/jasjeetmavi/orca/internal/task"
	"github.com/jasjeetmavi/orca/internal/worktree"
)

// ========== Task Operations ==========

func (s *Server) handleAddDep(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}

	s.withTask(func(w http.ResponseWriter, r *http.Request, tk *task.Task) {
		type depReq struct {
			DependsOn string `json:"depends_on"`
		}
		req, ok := decodeJSON[depReq](w, r, false)
		if !ok {
			return
		}

		store := s.taskStore
		depResolved, ok := resolveTaskID(w, store, req.DependsOn)
		if !ok {
			return
		}

		if err := store.AddDependency(tk.ID, depResolved); err != nil {
			jsonError(w, err, http.StatusInternalServerError)
			return
		}
		if updated, err := store.Get(tk.ID); err == nil {
			s.hub.Broadcast(Event{Type: "task.updated", Data: updated})
		}
		jsonOK(w, map[string]string{"task_id": tk.ID, "depends_on": depResolved})
	})(w, r)
}

func (s *Server) handleCleanup(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}

	type cleanupReq struct {
		DryRun bool `json:"dry_run"`
	}
	req, ok := decodeJSON[cleanupReq](w, r, true)
	if !ok {
		return
	}

	store := s.taskStore
	wm := s.executor.Worktrees()
	worktreeList, err := wm.List()
	if err != nil {
		jsonError(w, fmt.Errorf("list worktrees: %w", err), http.StatusInternalServerError)
		return
	}

	type staleEntry struct {
		taskID string
		branch string
	}

	var stale []staleEntry
	for _, wt := range worktreeList {
		if wt.Branch == "main" || wt.Branch == "master" || wt.Branch == "" {
			continue
		}
		if wt.Branch == "orca/integration" {
			continue
		}
		if !strings.HasPrefix(wt.Branch, "orca/task-") {
			continue
		}

		taskID := worktree.ExtractTaskID(wt.Branch)
		tk, err := store.Get(taskID)
		if err != nil {
			stale = append(stale, staleEntry{taskID: taskID, branch: wt.Branch})
			continue
		}
		if tk.Status == "approved" || tk.Status == "failed" {
			stale = append(stale, staleEntry{taskID: taskID, branch: wt.Branch})
		}
	}

	if req.DryRun {
		removedBranches := make([]string, 0, len(stale))
		for _, st := range stale {
			removedBranches = append(removedBranches, st.branch)
		}
		jsonOK(w, map[string]interface{}{
			"removed":   len(removedBranches),
			"worktrees": removedBranches,
		})
		return
	}

	s.runAsyncHandler(w, "cleanup", map[string]string{"status": "running"}, func() {
		s.hub.Broadcast(Event{Type: "cleanup.started", Data: map[string]interface{}{}})

		removedBranches := make([]string, 0, len(stale))
		for _, st := range stale {
			if err := wm.Remove(st.taskID); err != nil {
				continue
			}
			removedBranches = append(removedBranches, st.branch)
			s.hub.Broadcast(Event{Type: "cleanup.progress", Data: map[string]interface{}{
				"removed": st.branch,
			}})
		}

		s.hub.Broadcast(Event{Type: "cleanup.completed", Data: map[string]interface{}{
			"removed": len(removedBranches),
		}})
	})
}
