package api

import (
	"net/http"
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
	contextExists := false
	lastSyncedCommit := ""
	currentCommit := ""
	syncNeeded := false
	commitsBehind := 0
	contextStale := false
	memoryTotal := 0
	memoryStaleCount := 0

	if s.memoryStore != nil {
		if syncStatus, err := s.newMemorySyncer(s.memoryStore).Status(); err == nil && syncStatus != nil {
			lastSyncedCommit = syncStatus.LastSyncedCommit
			currentCommit = syncStatus.CurrentCommit
			syncNeeded = syncStatus.SyncNeeded
			commitsBehind = syncStatus.CommitsBehind
			contextStale = contextStale || syncStatus.ContextStale
		}
		if health, err := s.memoryStore.BuildHealthSummary(); err == nil && health != nil {
			memoryTotal = health.TotalEntries
			memoryStaleCount = health.StaleCount
		}
	}
	contextExists = memoryTotal > 0
	contextStale = contextStale || memoryStaleCount > 0

	status := map[string]interface{}{
		"project":             s.cfg.Project.Name,
		"total_tasks":         len(tasks),
		"pending":             counts["pending"],
		"in_progress":         counts["running"],
		"completed":           counts["completed"],
		"failed":              counts["failed"],
		"context_exists":      contextExists,
		"context_stale":       contextStale,
		"context_age_minutes": 0,
		"total_cost":          projectTotal,
		"running_operations":  len(runningInteractions),
		"last_synced_commit":  lastSyncedCommit,
		"current_commit":      currentCommit,
		"sync_needed":         syncNeeded,
		"commits_behind":      commitsBehind,
		"memory_total":        memoryTotal,
		"memory_stale_count":  memoryStaleCount,
	}

	jsonOK(w, status)
}
