package api

import (
	"net/http"

	"github.com/jasjeetmavi/orca/internal/cost"
	"github.com/jasjeetmavi/orca/internal/explore"
	"github.com/jasjeetmavi/orca/internal/task"
)

// ========== Status ==========

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	store := task.NewStore(s.db)
	tasks, _ := store.List()

	counts := map[string]int{}
	for _, t := range tasks {
		counts[t.Status]++
	}

	active, _ := s.planner.GetActive()
	ct := cost.NewTracker(s.db)
	projectTotal, _ := ct.ProjectTotal()
	contextExists := explore.LoadContext(s.repoDir) != ""
	stale, _ := explore.IsStale(s.repoDir)
	age := explore.ContextAge(s.repoDir)

	status := map[string]interface{}{
		"project":             s.cfg.Project.Name,
		"total_tasks":         len(tasks),
		"pending":             counts["pending"],
		"in_progress":         counts["in_sprint"] + counts["running"],
		"completed":           counts["completed"],
		"failed":              counts["failed"],
		"context_exists":      contextExists,
		"context_stale":       stale,
		"context_age_minutes": int(age.Minutes()),
		"total_cost":          projectTotal,
		"budget":              s.cfg.Orchestrator.CostBudget,
	}

	if active != nil {
		status["active_sprint"] = map[string]string{
			"id":     active.ID,
			"status": active.Status,
		}
	}

	jsonOK(w, status)
}

// ========== Plan Sprint (standalone route) ==========

// This is the handler used by POST /api/v1/sprints/plan
// It's also called from routeSprintByID when the sub-path is "plan"
// but we already handle it above. Let's alias it for the mux entry:
func init() {
	// no-op; planSprint is called via routeSprintByID
}
