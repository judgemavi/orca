package api

import (
	"net/http"

	"github.com/jasjeetmavi/orca/internal/cost"
)

// ========== Costs ==========

func (s *Server) handleCosts(w http.ResponseWriter, r *http.Request) {
	ct := cost.NewTracker(s.db)
	runID := r.URL.Query().Get("run_id")

	if runID != "" {
		total, _ := ct.RunTotal(runID)
		summary, _ := ct.RunSummary(runID)
		jsonOK(w, map[string]interface{}{
			"run_id": runID,
			"total":  total,
			"tools":  summary,
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
