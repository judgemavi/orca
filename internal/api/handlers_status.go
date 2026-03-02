package api

import (
	"net/http"

	"github.com/jasjeetmavi/orca/internal/explore"
)

// ========== Status ==========

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	store := s.taskStore
	tasks, _ := store.List()

	counts := map[string]int{}
	for _, t := range tasks {
		counts[t.Status]++
	}

	projectTotal, _ := s.interactions.ProjectTotal()
	runningInteractions, _ := s.interactions.ListByStatus("running")
	contextExists := explore.LoadContext(s.repoDir) != ""
	staleByHash, _ := explore.IsStale(s.repoDir)
	age := explore.ContextAge(s.repoDir)
	lastSyncedCommit := ""
	currentCommit := ""
	syncNeeded := false
	commitsBehind := 0
	contextStale := staleByHash

	if s.memoryStore != nil {
		if syncStatus, err := s.newMemorySyncer(s.memoryStore).Status(); err == nil && syncStatus != nil {
			lastSyncedCommit = syncStatus.LastSyncedCommit
			currentCommit = syncStatus.CurrentCommit
			syncNeeded = syncStatus.SyncNeeded
			commitsBehind = syncStatus.CommitsBehind
			contextStale = contextStale || syncStatus.ContextStale
		}
	}

	status := map[string]interface{}{
		"project":             s.cfg.Project.Name,
		"total_tasks":         len(tasks),
		"pending":             counts["pending"],
		"in_progress":         counts["running"],
		"completed":           counts["completed"],
		"failed":              counts["failed"],
		"context_exists":      contextExists,
		"context_stale":       contextStale,
		"context_age_minutes": int(age.Minutes()),
		"total_cost":          projectTotal,
		"running_operations":  len(runningInteractions),
		"last_synced_commit":  lastSyncedCommit,
		"current_commit":      currentCommit,
		"sync_needed":         syncNeeded,
		"commits_behind":      commitsBehind,
	}

	jsonOK(w, status)
}
