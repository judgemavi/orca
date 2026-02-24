package api

import (
	"net/http"

	"github.com/jasjeetmavi/orca/internal/cost"
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

	ct := cost.NewTracker(s.db)
	projectTotal, _ := ct.ProjectTotal()
	contextExists := explore.LoadContext(s.repoDir) != ""
	stale, _ := explore.IsStale(s.repoDir)
	age := explore.ContextAge(s.repoDir)

	status := map[string]interface{}{
		"project":             s.cfg.Project.Name,
		"total_tasks":         len(tasks),
		"pending":             counts["pending"],
		"in_progress":         counts["running"],
		"completed":           counts["completed"],
		"failed":              counts["failed"],
		"context_exists":      contextExists,
		"context_stale":       stale,
		"context_age_minutes": int(age.Minutes()),
		"total_cost":          projectTotal,
		"budget":              s.cfg.Orchestrator.CostBudget,
	}

	jsonOK(w, status)
}
