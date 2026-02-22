package api

import (
	"net/http"

	"github.com/jasjeetmavi/orca/internal/cost"
)

// ========== Costs ==========

func (s *Server) handleCosts(w http.ResponseWriter, r *http.Request) {
	ct := cost.NewTracker(s.db)
	sprintFlag := r.URL.Query().Get("sprint_id")

	if sprintFlag != "" {
		total, _ := ct.SprintTotal(sprintFlag)
		summary, _ := ct.SprintSummary(sprintFlag)
		jsonOK(w, map[string]interface{}{
			"sprint_id": sprintFlag,
			"total":     total,
			"tools":     summary,
		})
		return
	}

	projectTotal, _ := ct.ProjectTotal()
	summary, _ := ct.ProjectSummary()
	budget := s.cfg.Orchestrator.CostBudget
	remaining, _ := ct.BudgetRemaining(budget)

	jsonOK(w, map[string]interface{}{
		"total":     projectTotal,
		"budget":    budget,
		"remaining": remaining,
		"tools":     summary,
	})
}
